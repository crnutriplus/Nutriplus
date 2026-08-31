"use client";

/* The invoice viewer must display the private original bytes without image optimization. */
/* eslint-disable @next/next/no-img-element */

import {
  AlertCircle,
  Barcode,
  Bot,
  Camera,
  Check,
  ClipboardPaste,
  FileArchive,
  FileClock,
  FileSearch,
  FileText,
  History,
  ImageUp,
  Loader2,
  PackagePlus,
  Plus,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { validateBarcode } from "@/lib/barcodes";
import { canonicalProductIdentity, type IntakeLineDto, type IntakeLineStatus } from "@/lib/inventory-intake";
import { normalizePresentation } from "@/lib/product-presentation";
import { calculatePrices, normalizeName, searchProducts, type NonInventoryRecord, type PricingSettings, type ProductRecord } from "@/lib/pricing";

type Notice = { type: "success" | "info" | "error" | "warning"; title?: string; text: string; sticky?: boolean; dismissOnPageTouch?: boolean; durationMs?: number };

type IntakeDocument = {
  id: string;
  fingerprint: string;
  fileName: string;
  mimeTypes?: string[];
  provider: "amazon" | "iherb" | "other";
  orderNumber: string;
  invoiceNumber: string;
  shipmentNumber: string;
  documentDate: string;
  pageCount: number;
  fileCount: number;
  processingMode: "ai" | "manual" | "chatgpt_import";
  analysisStatus: string;
  activeAnalysisId: string;
  fieldEvidence: Record<string, { value?: string; confidence?: number; page?: number; source?: string }>;
  status: string;
  warnings: string[];
  duplicateOf: string;
  createdAt: string;
  confirmedAt: string;
};

type IntakeInvoiceFile = {
  id: string;
  index: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  viewUrl: string;
};

type InvoiceAnalysis = {
  id: string;
  analysisNumber: number;
  model: string;
  analysisOrigin: "OPENAI_API" | "CHATGPT_IMPORT" | string;
  apiCalls: number;
  apiCostUsd: number;
  status: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  webSearchCount: number;
  estimatedCostUsd: number;
  cumulativeCostUsd: number;
  reanalysis: boolean;
  reviewRequired: boolean;
  errorCode: string;
  errorMessage: string;
  createdAt: string;
  completedAt: string;
  importSummary: {
    pageCount: number;
    currency: string;
    subtotal: number;
    shipping: number;
    tax: number;
    total: number;
    lineCount: number;
    inventoryUnits: number;
    sourceSha256: string;
  } | null;
};

type InvoiceUsage = {
  cumulativeCostUsd: number;
  currentMonthCostUsd: number;
  billedAnalyses: number;
  month: string;
};

type InvoiceAiConfig = {
  aiEnabled: boolean;
  aiAvailable: boolean;
  keyConfigured: boolean;
  model: string;
  monthlyLimitUsd: number;
  currentMonthCostUsd: number;
  cumulativeCostUsd: number;
  billedAnalyses: number;
  month: string;
  limitReached: boolean;
};

type IntakeLoadResult = {
  document: IntakeDocument;
  lines: IntakeLineDto[];
  files: IntakeInvoiceFile[];
  analysis: InvoiceAnalysis | null;
  analyses: InvoiceAnalysis[];
  usage: InvoiceUsage;
  duplicate: boolean;
  exactDuplicate: boolean;
  resumed?: boolean;
  cachedAnalysis?: boolean;
  manualFallback?: boolean;
  aiErrorCode?: string;
  aiErrorMessage?: string;
  reviewRequired?: boolean;
  ocrFallbackApplied?: boolean;
  recovered?: boolean;
  recoveryState?: "draft" | "partial" | "completed";
  processedLines?: number;
  ignoredLines?: number;
  pendingLines?: number;
  apiCalls?: number;
  apiCostUsd?: number;
  notice?: {
    type: "success" | "info" | "error" | "warning";
    title: string;
    message: string;
    code: string;
  };
};

type CodeCandidate = {
  code: string;
  type: string;
  source: string;
  sourceUrl: string;
  title: string;
  presentation: string;
  confidence: number;
  differences: string[];
};

type IntakeOperation = {
  id: string;
  documentId: string;
  operationType: "ingress" | "quick" | "reversal";
  reversalOf: string;
  reason: string;
  confirmedBy: string;
  lineCount: number;
  totalUnits: number;
  confirmedAt: string;
  fileName: string;
  provider: string;
  invoiceNumber: string;
  orderNumber: string;
  shipmentNumber: string;
  reversed: boolean;
  movements: Array<{
    id: string;
    productId: number;
    productName: string;
    barcode: string;
    previousQuantity: number;
    quantityChange: number;
    resultingQuantity: number;
  }>;
};

type IntakeHistoryDocument = IntakeDocument & {
  lineCount: number;
  ingressedLines: number;
  pendingLines: number;
  omittedLines: number;
  reversedLines: number;
  activeUnits: number;
  pendingUnits: number;
  lines: IntakeLineDto[];
};

export type IntakeScanEvent = { lineId: string; code: string; nonce: number } | null;

type Props = {
  open: boolean;
  products: ProductRecord[];
  quotes: NonInventoryRecord[];
  settings: PricingSettings;
  quickText: string;
  setQuickText: (value: string) => void;
  onQuickSave: () => void;
  onClose: () => void;
  onNotify: (notice: Notice) => void;
  onProductsChanged: (products: ProductRecord[]) => void;
  onEditProduct: (productId: number) => void;
  onRefresh: () => Promise<void>;
  onRequestScan: (lineId: string) => void;
  scannedBarcode: IntakeScanEvent;
  onConsumeScan: () => void;
  readBarcodeImage: (file: File) => Promise<string>;
};

const STATUS_LABELS: Record<IntakeLineStatus, string> = {
  confirmed: "Coincidencia confirmada",
  requires_confirm_code: "Requiere confirmar código",
  requires_select_product: "Requiere seleccionar producto",
  requires_conversion: "Requiere definir conversión",
  new_product: "Producto nuevo",
  non_inventory: "Producto en No inventario",
  pending_receive: "Pendiente de recibir",
  ignored: "Omitido / No agregado",
  conflict_identifiers: "Conflicto de identificadores",
  processed: "Procesado",
};

function documentStatusLabel(status: string) {
  if (status === "processed") return "Procesada";
  if (status === "partial") return "Parcial";
  if (status === "reviewing") return "En revisión";
  return "Borrador";
}

function pendingQuantity(line: IntakeLineDto) {
  return Math.max(0, Number(line.availableQuantity ?? line.totalToAdd));
}

function lineAfterConfirmation(line: IntakeLineDto, processedOperationId: string) {
  const added = pendingQuantity(line);
  return {
    ...line,
    status: "processed" as const,
    processedOperationId,
    selectedForIngress: false,
    activeQuantity: Number(line.activeQuantity || 0) + added,
    availableQuantity: 0,
  };
}

const CONFIRMABLE = new Set<IntakeLineStatus>(["confirmed", "new_product", "non_inventory"]);
const ACTIVE_INVOICE_DRAFT_KEY = "nutriplus-active-invoice-draft";
const OPEN_INVOICE_REQUEST_KEY = "nutriplus-open-invoice-request";

const EVIDENCE_LABELS: Record<string, string> = {
  provider: "Proveedor",
  order_number: "Pedido",
  invoice_number: "Factura",
  document_date: "Fecha",
  shipment_number: "Rastreo",
  name: "Producto",
  brand: "Marca",
  presentation: "Presentación",
  size: "Tamaño",
  flavor: "Sabor",
  concentration: "Concentración",
  quantity: "Cantidad",
  unit_price: "Precio unitario",
  discount_total: "Descuento",
  line_subtotal: "Subtotal de línea",
  currency: "Moneda",
  total: "Total",
  package_units: "Unidades por paquete",
  iherb_code: "Código iHerb",
  asin: "ASIN",
  barcode: "Código de barras",
};

function costLabel(value: number) {
  if (!Number.isFinite(value) || value === 0) return "$0.00";
  return `$${value.toFixed(value >= 1 ? 2 : 4)}`;
}

function analysisOriginLabel(origin: string) {
  return origin === "CHATGPT_IMPORT" ? "ChatGPT Import" : "OpenAI API";
}

function importedMoney(value: number, currency: string) {
  return `${currency || "USD"} ${value.toFixed(2)}`;
}

function analysisStatusLabel(status: string) {
  if (status === "completed") return "Completado";
  if (status === "review_required") return "Revisión requerida";
  if (status === "failed") return "Fallido";
  if (status === "processing") return "Procesando";
  return status || "Sin estado";
}

function analysisDateLabel(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("es-CR");
}

function evidenceEntries(evidence: IntakeDocument["fieldEvidence"] | IntakeLineDto["fieldEvidence"]) {
  return Object.entries(evidence || {}).filter(([, item]) => item && typeof item === "object");
}

type IntakeApiFailure = { error?: string; errors?: string[]; title?: string; code?: string; reference?: string };

class IntakeApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public payload: IntakeApiFailure,
  ) { super(message); }
}

async function apiJson<T>(response: Response) {
  const raw = await response.text();
  let body: T & IntakeApiFailure;
  try {
    body = raw ? JSON.parse(raw) as T & IntakeApiFailure : {} as T & IntakeApiFailure;
  } catch {
    if (response.status === 401) throw new IntakeApiError("Tu sesión venció. Iniciá sesión nuevamente para continuar. El progreso que ya estaba guardado no se perdió.", 401, { code: "AUTH_SESSION_EXPIRED", title: "Sesión vencida" });
    if (response.status === 403) throw new IntakeApiError("No tenés permiso para realizar esta acción.", 403, { code: "AUTH_FORBIDDEN", title: "Sin permisos" });
    throw new IntakeApiError(response.ok
      ? "El servidor devolvió una respuesta que no se pudo leer. Intentá nuevamente."
      : "No pudimos completar esta operación por un problema temporal de NutriPlus. No se realizaron cambios nuevos en el inventario. Intentá nuevamente.", response.status, { code: "SERVER_RESPONSE_INVALID", title: "Problema temporal de NutriPlus" });
  }
  if (!response.ok) {
    if (response.status === 401) throw new IntakeApiError("Tu sesión venció. Iniciá sesión nuevamente para continuar. El progreso que ya estaba guardado no se perdió.", 401, { ...body, code: "AUTH_SESSION_EXPIRED", title: "Sesión vencida" });
    if (response.status === 403) throw new IntakeApiError("No tenés permiso para realizar esta acción.", 403, { ...body, code: "AUTH_FORBIDDEN", title: "Sin permisos" });
    const details = body.errors?.length ? ` ${body.errors.join(" ")}` : "";
    throw new IntakeApiError(`${body.error || "No se pudo completar la operación."}${details}`, response.status, body);
  }
  return body;
}

function operationId(prefix: string) {
  return `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function intakeErrorText(error: unknown, fallback: string) {
  const raw = error instanceof Error ? error.message.trim() : "";
  if (!raw) return fallback;
  if (/failed to fetch|networkerror|network error|load failed/i.test(raw)) return "No se pudo conectar con NutriPlus. Verificá Internet e intentá nuevamente.";
  if (/aborterror|aborted|cancelled|canceled/i.test(raw)) return "La operación se interrumpió antes de terminar. Intentá nuevamente.";
  if (/[áéíóúñ¿¡]/i.test(raw) || /^(?:No se|El |La |Los |Las |Revisá|Ingresá|Seleccioná|Ocurrió|Código|Factura|Archivo)/i.test(raw)) return raw;
  return fallback;
}

function intakeErrorNotice(error: unknown, fallbackTitle: string, fallbackText: string) {
  return {
    title: error instanceof IntakeApiError && error.payload.title ? error.payload.title : fallbackTitle,
    text: intakeErrorText(error, fallbackText),
  };
}

function equivalentOwners(code: string, products: ProductRecord[], quotes: NonInventoryRecord[]) {
  const target = validateBarcode(code);
  if (!target.valid || !target.canonical) return { products: [] as ProductRecord[], quotes: [] as NonInventoryRecord[] };
  return {
    products: products.filter((product) => validateBarcode(product.code).canonical === target.canonical),
    quotes: quotes.filter((quote) => validateBarcode(quote.code).canonical === target.canonical),
  };
}

function pickerResults(line: IntakeLineDto, products: ProductRecord[], quotes: NonInventoryRecord[], query: string) {
  const normalized = normalizeName(query);
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const candidates = [
    ...products.map((product) => ({ source: "inventory" as const, product, search: [product.name, product.brand || "", product.presentation || "", product.code || ""].join(" ") })),
    ...quotes.map((product) => ({ source: "no_inventory" as const, product, search: [product.name, product.code || ""].join(" ") })),
  ].filter((candidate) => !tokens.length || tokens.every((token) => normalizeName(candidate.search).includes(token)));
  const suggested = new Map(line.suggestions.map((item, index) => [`${item.source}:${item.id}`, index]));
  const searchedProducts = new Map(searchProducts(products, query).map((product, index) => [product.id, index]));
  return candidates.sort((left, right) => {
    const leftKey = `${left.source}:${left.product.id}`;
    const rightKey = `${right.source}:${right.product.id}`;
    const leftSuggested = suggested.get(leftKey);
    const rightSuggested = suggested.get(rightKey);
    if (leftSuggested != null || rightSuggested != null) return (leftSuggested ?? 99) - (rightSuggested ?? 99);
    if (left.source === "inventory" && right.source === "inventory") return (searchedProducts.get(left.product.id) ?? 99_999) - (searchedProducts.get(right.product.id) ?? 99_999);
    return left.product.name.localeCompare(right.product.name, "es");
  }).slice(0, 40);
}

function canonicalInventorySelection(product: ProductRecord): Partial<IntakeLineDto> {
  const canonical = canonicalProductIdentity(product);
  return {
    ...(canonical.barcode ? {
      barcode: canonical.barcode.value,
      canonicalBarcode: canonical.barcode.canonical,
      barcodeType: canonical.barcode.type,
      barcodeConfirmed: true,
      barcodeMethod: "product_catalog",
      barcodeSource: "Producto canónico de NutriPlus",
      barcodeSourceUrl: "",
      barcodeSourceTitle: product.name,
      barcodeDifferences: [],
      barcodeLookupStatus: "found_exact" as const,
    } : {}),
    name: canonical.name,
    brand: canonical.brand,
    presentation: canonical.presentation,
    ...(canonical.presentation ? { size: canonical.presentation } : {}),
    matchProductId: canonical.id,
    matchNonInventoryId: null,
    action: "existing",
    match: {
      source: "inventory",
      id: canonical.id,
      name: canonical.name,
      code: canonical.barcode?.value || null,
      quantityAvailable: canonical.quantityAvailable,
      brand: canonical.brand || null,
      presentation: canonical.presentation || null,
      minimumStock: canonical.minimumStock,
      minimumStockEnabled: canonical.minimumStockEnabled,
      matchReason: "identity",
    },
  };
}

function classifyLine(line: IntakeLineDto, products: ProductRecord[], quotes: NonInventoryRecord[]): IntakeLineDto {
  if (line.action === "ignore" || line.status === "processed") return line;
  const barcode = validateBarcode(line.barcode);
  if (!barcode.valid || !barcode.normalized || !barcode.canonical) {
    return {
      ...line,
      barcodeConfirmed: false,
      status: "requires_confirm_code",
      action: line.matchProductId ? "existing" : line.matchNonInventoryId ? "move" : "pending",
      canonicalBarcode: "",
      barcodeType: "",
    };
  }
  const owners = equivalentOwners(barcode.normalized, products, quotes);
  let next: IntakeLineDto = { ...line, barcode: barcode.normalized, canonicalBarcode: barcode.canonical, barcodeType: barcode.type || "" };
  if (owners.products.length + owners.quotes.length > 1) {
    next = { ...next, status: "conflict_identifiers", action: "pending", warnings: [...new Set([...next.warnings, "Este código equivalente aparece en más de un registro."])] };
  } else if (line.matchProductId) {
    const product = products.find((item) => item.id === line.matchProductId);
    const owner = owners.products[0] || owners.quotes[0];
    next = !product || (owner && (!owners.products[0] || owner.id !== product.id))
      ? { ...next, status: "conflict_identifiers", action: "pending" }
      : { ...next, status: "confirmed", action: "existing", match: { source: "inventory", id: product.id, name: product.name, code: product.code, quantityAvailable: product.quantityAvailable, brand: product.brand || null, presentation: product.presentation || null, minimumStock: product.minimumStock, minimumStockEnabled: product.minimumStockEnabled, matchReason: "identity" }, matchNonInventoryId: null };
  } else if (line.matchNonInventoryId) {
    const quote = quotes.find((item) => item.id === line.matchNonInventoryId);
    const owner = owners.products[0] || owners.quotes[0];
    next = !quote || (owner && (!owners.quotes[0] || owner.id !== quote.id))
      ? { ...next, status: "conflict_identifiers", action: "pending" }
      : { ...next, status: "non_inventory", action: "move", match: { source: "no_inventory", id: quote.id, name: quote.name, code: quote.code, quantityAvailable: null }, matchProductId: null };
  } else if (owners.products.length === 1) {
    const product = owners.products[0];
    next = { ...next, status: "confirmed", action: "existing", matchProductId: product.id, matchNonInventoryId: null, match: { source: "inventory", id: product.id, name: product.name, code: product.code, quantityAvailable: product.quantityAvailable } };
  } else if (owners.quotes.length === 1) {
    const quote = owners.quotes[0];
    next = { ...next, status: "non_inventory", action: "move", matchProductId: null, matchNonInventoryId: quote.id, match: { source: "no_inventory", id: quote.id, name: quote.name, code: quote.code, quantityAvailable: null } };
  } else {
    next = { ...next, status: "new_product", action: "create", matchProductId: null, matchNonInventoryId: null, match: null };
  }
  if (!next.barcodeConfirmed && !["ignored", "processed", "conflict_identifiers"].includes(next.status)) {
    return { ...next, status: "requires_confirm_code" };
  }
  if (next.receivedQuantity === null) return { ...next, status: "pending_receive", action: "pending" };
  if (next.unitsPerPackage > 1 && !next.barcodeLevel) return { ...next, status: "requires_conversion", action: "pending" };
  return { ...next, totalToAdd: Math.max(0, (next.receivedQuantity || 0) * Math.max(1, next.unitsPerPackage)) };
}

function emptyManualLine(): IntakeLineDto {
  const id = `iline-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  return {
    id,
    lineKey: `manual-${id}`,
    pageNumber: null,
    originalDescription: "Producto agregado manualmente",
    name: "",
    brand: "",
    presentation: "",
    size: "",
    flavor: "",
    concentration: "",
    billedQuantity: null,
    receivedQuantity: null,
    unitsPerPackage: 1,
    totalToAdd: 0,
    barcode: "",
    canonicalBarcode: "",
    barcodeType: "",
    secondaryId: "",
    secondaryType: "",
    barcodeMethod: "manual",
    barcodeSource: "Confirmado por el usuario",
    barcodeSourceUrl: "",
    barcodeSourceTitle: "Confirmado por el usuario",
    barcodeDifferences: [],
    barcodeLookupStatus: "pending",
    barcodeConfirmed: false,
    selectedForIngress: true,
    reviewSavedAt: "",
    confidence: 100,
    fieldEvidence: {},
    status: "requires_confirm_code",
    action: "pending",
    barcodeLevel: "unit",
    matchProductId: null,
    matchNonInventoryId: null,
    match: null,
    suggestions: [],
    warnings: [],
    processedOperationId: "",
  };
}

export function InventoryIntakeModal(props: Props) {
  const {
    open, products, quotes, settings, quickText, setQuickText, onQuickSave, onClose, onNotify,
    onProductsChanged, onEditProduct, onRefresh, onRequestScan, scannedBarcode, onConsumeScan, readBarcodeImage,
  } = props;
  const [tab, setTab] = useState<"invoice" | "quick" | "history">("invoice");
  const [document, setDocument] = useState<IntakeDocument | null>(null);
  const [invoiceMode, setInvoiceMode] = useState<"ai" | "manual" | "chatgpt_import">("ai");
  const [aiConfig, setAiConfig] = useState<InvoiceAiConfig | null>(null);
  const [invoiceFiles, setInvoiceFiles] = useState<IntakeInvoiceFile[]>([]);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [analysis, setAnalysis] = useState<InvoiceAnalysis | null>(null);
  const [analyses, setAnalyses] = useState<InvoiceAnalysis[]>([]);
  const [analysisHistoryOpen, setAnalysisHistoryOpen] = useState(false);
  const [usage, setUsage] = useState<InvoiceUsage | null>(null);
  const uploadedFilesRef = useRef<File[]>([]);
  const [lines, setLines] = useState<IntakeLineDto[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reading, setReading] = useState(false);
  const [readProgress, setReadProgress] = useState({ current: 0, total: 1, message: "" });
  const [confirming, setConfirming] = useState(false);
  const confirmingRef = useRef(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const savingDraftRef = useRef(false);
  const [dirtyLineIds, setDirtyLineIds] = useState<Set<string>>(new Set());
  const lineRevisionRef = useRef<Map<string, number>>(new Map());
  const [deletedLineIds, setDeletedLineIds] = useState<Set<string>>(new Set());
  const [metaDirty, setMetaDirty] = useState(false);
  const metaRevisionRef = useRef(0);
  const [removeLineTarget, setRemoveLineTarget] = useState<IntakeLineDto | null>(null);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [savingLineId, setSavingLineId] = useState<string | null>(null);
  const [confirmingLineId, setConfirmingLineId] = useState<string | null>(null);
  const [removingLineId, setRemovingLineId] = useState<string | null>(null);
  const [ocrReading, setOcrReading] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [reanalyzeConfirmOpen, setReanalyzeConfirmOpen] = useState(false);
  const [reanalyzeTarget, setReanalyzeTarget] = useState<"primary" | "sol">("primary");
  const [lookupLineId, setLookupLineId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Record<string, CodeCandidate[]>>({});
  const [lookupMessages, setLookupMessages] = useState<Record<string, string>>({});
  const [pendingBarcode, setPendingBarcode] = useState<{
    lineId: string;
    code: string;
    method: string;
    source: string;
    sourceUrl?: string;
    sourceTitle?: string;
    differences?: string[];
  } | null>(null);
  const [manualCodeLine, setManualCodeLine] = useState<string | null>(null);
  const [history, setHistory] = useState<IntakeOperation[]>([]);
  const [historyDocuments, setHistoryDocuments] = useState<IntakeHistoryDocument[]>([]);
  const [openHistoryDocumentId, setOpenHistoryDocumentId] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [reverseTarget, setReverseTarget] = useState<IntakeOperation | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const [reversing, setReversing] = useState(false);
  const [pendingVerification, setPendingVerification] = useState<{ operationId: string; documentId: string; lineIds?: string[] } | null>(null);
  const [createProductLine, setCreateProductLine] = useState<IntakeLineDto | null>(null);
  const [creatingProduct, setCreatingProduct] = useState(false);
  const [newProduct, setNewProduct] = useState({ name: "", brand: "", presentation: "", code: "", purchasePriceUsd: "", weightLb: "" });
  const [minimumStockEnabled, setMinimumStockEnabled] = useState(false);
  const [minimumStock, setMinimumStock] = useState("0");
  const [matchPickerLineId, setMatchPickerLineId] = useState<string | null>(null);
  const [matchQuery, setMatchQuery] = useState("");
  const resumeAttempted = useRef(false);
  const inlinePricing = useMemo(() => {
    const purchase = Number(newProduct.purchasePriceUsd);
    const weight = Number(newProduct.weightLb);
    return newProduct.purchasePriceUsd !== "" && newProduct.weightLb !== "" && Number.isFinite(purchase) && purchase >= 0 && Number.isFinite(weight) && weight >= 0
      ? calculatePrices(purchase, weight, settings)
      : null;
  }, [newProduct.purchasePriceUsd, newProduct.weightLb, settings]);

  const updateLine = useCallback((id: string, changes: Partial<IntakeLineDto>, reclassify = true) => {
    lineRevisionRef.current.set(id, (lineRevisionRef.current.get(id) || 0) + 1);
    setDirtyLineIds((current) => new Set(current).add(id));
    setLines((current) => current.map((line) => {
      if (line.id !== id) return line;
      const next = { ...line, ...changes };
      next.totalToAdd = Math.max(0, (next.receivedQuantity || 0) * Math.max(1, next.unitsPerPackage));
      if (!next.movementHistory?.length) {
        next.originalQuantity = next.totalToAdd;
        next.activeQuantity = 0;
        next.availableQuantity = next.totalToAdd;
      }
      return reclassify ? classifyLine(next, products, quotes) : next;
    }));
  }, [products, quotes]);

  const updateDocumentMeta = useCallback((changes: Partial<IntakeDocument>) => {
    metaRevisionRef.current += 1;
    setMetaDirty(true);
    setDocument((current) => current ? { ...current, ...changes } : current);
  }, []);

  function openCreateProduct(line: IntakeLineDto) {
    const net = Number(line.fieldEvidence?.net_line_cost?.value || 0);
    const quantity = Math.max(1, Number(line.billedQuantity || 1));
    setCreateProductLine(line);
    setNewProduct({ name: line.name, brand: line.brand, presentation: normalizePresentation(line.presentation || line.size || line.originalDescription) || line.presentation, code: line.barcode || "", purchasePriceUsd: net > 0 ? (net / quantity).toFixed(2) : "", weightLb: "" });
    setMinimumStockEnabled(false);
    setMinimumStock("0");
  }

  async function saveInlineProduct() {
    if (!createProductLine || !newProduct.name.trim() || creatingProduct) return;
    if (newProduct.purchasePriceUsd === "" || newProduct.weightLb === "") {
      onNotify({ type: "error", text: "Faltan el precio de compra o el peso. Completalos para calcular el precio; la factura sigue abierta y no se agregó inventario.", sticky: true });
      return;
    }
    const sameName = products.find((product) => normalizeName(product.name) === normalizeName(newProduct.name));
    if (sameName) {
      onNotify({ type: "error", text: `Ya existe el producto ${sameName.name}. Seleccionalo en la línea en lugar de crear otro; la factura sigue abierta y no se agregó inventario.`, sticky: true });
      return;
    }
    let normalizedCode: string | null = null;
    if (newProduct.code.trim()) {
      const checked = validateBarcode(newProduct.code);
      if (!checked.valid || !checked.normalized) {
        onNotify({ type: "error", text: `${checked.error || "El código de barras no es válido."} Corregilo o escanealo nuevamente; la factura sigue abierta y no se agregó inventario.`, sticky: true });
        return;
      }
      const owners = equivalentOwners(checked.normalized, products, quotes);
      const existingOwner = owners.products[0] || owners.quotes[0];
      if (existingOwner) {
        onNotify({ type: "error", text: `El código ${checked.normalized} ya pertenece a ${existingOwner.name}. Seleccioná ese producto o usá otro código; la factura sigue abierta y no se agregó inventario.`, sticky: true });
        return;
      }
      normalizedCode = checked.normalized;
    }
    setCreatingProduct(true);
    const mutationId = operationId("invoice-product");
    try {
      const result = await apiJson<{ product: ProductRecord; deduplicated?: boolean }>(await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mutation-Id": mutationId },
        body: JSON.stringify({ mutationId, name: newProduct.name.trim(), brand: newProduct.brand.trim() || null, presentation: newProduct.presentation.trim() || null, code: normalizedCode,
          purchasePriceUsd: newProduct.purchasePriceUsd === "" ? null : Number(newProduct.purchasePriceUsd),
          weightLb: newProduct.weightLb === "" ? null : Number(newProduct.weightLb), quantityAvailable: 0,
          minimumStock: minimumStockEnabled ? Math.max(0, Number(minimumStock) || 0) : 0, minimumStockEnabled }),
      }));
      const product = result.product;
      onProductsChanged(products.some((item) => item.id === product.id)
        ? products.map((item) => item.id === product.id ? product : item)
        : [...products, product]);
      updateLine(createProductLine.id, canonicalInventorySelection(product));
      setCreateProductLine(null);
      setMatchPickerLineId(null);
      onNotify({ type: "success", text: result.deduplicated
        ? "El producto ya existía y quedó seleccionado. La factura y su progreso se conservaron."
        : "Producto creado y seleccionado en esta misma línea. La factura continúa abierta y el inventario todavía no aumentó." });
    } catch (error) {
      onNotify({ type: "error", text: `${intakeErrorText(error, "No pudimos crear el producto.")} La factura sigue abierta y no se agregó inventario.`, sticky: true });
    } finally { setCreatingProduct(false); }
  }

  const resetInvoiceReview = useCallback(() => {
    try { sessionStorage.removeItem(ACTIVE_INVOICE_DRAFT_KEY); } catch { /* Storage is optional. */ }
    resumeAttempted.current = false;
    setDocument(null);
    setInvoiceFiles([]);
    setSelectedFileIndex(0);
    setAnalysis(null);
    setAnalyses([]);
    setAnalysisHistoryOpen(false);
    setUsage(null);
    uploadedFilesRef.current = [];
    setLines([]);
    setSelected(new Set());
    setDirtyLineIds(new Set());
    lineRevisionRef.current.clear();
    setDeletedLineIds(new Set());
    setMetaDirty(false);
    metaRevisionRef.current = 0;
    setCandidates({});
    setLookupMessages({});
    setPendingBarcode(null);
    setManualCodeLine(null);
    setRemoveLineTarget(null);
    setCancelConfirmOpen(false);
    setCloseConfirmOpen(false);
    setReanalyzeConfirmOpen(false);
    setSavingLineId(null);
    setConfirmingLineId(null);
    setRemovingLineId(null);
    setCreateProductLine(null);
    setCreatingProduct(false);
    setMinimumStockEnabled(false);
    setMinimumStock("0");
    setMatchPickerLineId(null);
    setMatchQuery("");
  }, []);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void fetch("/api/inventory-intake/config")
      .then((response) => apiJson<InvoiceAiConfig>(response))
      .then((config) => {
        if (!active) return;
        setAiConfig(config);
        if (!config.aiAvailable) setInvoiceMode("manual");
      })
      .catch((error) => {
        if (!active) return;
        setAiConfig(null);
        setInvoiceMode("manual");
        onNotify({ type: "error", text: intakeErrorText(error, "No se pudo consultar el estado del análisis con IA. El modo Manual continúa disponible."), sticky: true });
      });
    return () => { active = false; };
  }, [onNotify, open]);

  useEffect(() => {
    if (!open || document || resumeAttempted.current) return;
    let active = true;
    let draftId = "";
    try { draftId = sessionStorage.getItem(OPEN_INVOICE_REQUEST_KEY) || JSON.parse(sessionStorage.getItem(ACTIVE_INVOICE_DRAFT_KEY) || "{}").documentId || ""; } catch { /* No resumable invoice. */ }
    if (!draftId || typeof draftId !== "string") return;
    resumeAttempted.current = true;
    void fetch(`/api/inventory-intake/${encodeURIComponent(draftId)}`)
      .then((response) => apiJson<IntakeLoadResult>(response))
      .then((result) => {
        if (!active) return;
        applyLoadedResult(result);
        onNotify({ type: "info", text: "Recuperamos la factura en progreso. Sus líneas, asociaciones y cantidades siguen guardadas." });
      })
      .catch(() => {
        try { sessionStorage.removeItem(ACTIVE_INVOICE_DRAFT_KEY); } catch { /* Storage is optional. */ }
      });
    return () => { active = false; };
  // applyLoadedResult is intentionally declared below and stable for the mounted modal lifecycle.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document, onNotify, open]);

  useEffect(() => {
    if (!scannedBarcode) return;
    const checked = validateBarcode(scannedBarcode.code);
    if (!checked.valid || !checked.normalized) {
      onNotify({ type: "error", text: checked.error || "El código escaneado no es válido." });
      onConsumeScan();
      return;
    }
    if (scannedBarcode.lineId.startsWith("inline:")) {
      const targetLineId = scannedBarcode.lineId.slice("inline:".length);
      if (createProductLine?.id === targetLineId) {
        // El escáner entrega un evento externo que debe hidratar el formulario una sola vez.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setNewProduct((current) => ({ ...current, code: checked.normalized || "" }));
        onNotify({ type: "success", text: `Código ${checked.normalized} agregado al producto nuevo. El formulario y la factura permanecen abiertos.` });
      }
      onConsumeScan();
      return;
    }
    setPendingBarcode({ lineId: scannedBarcode.lineId, code: checked.normalized, method: "scanner", source: "Producto físico escaneado" });
    onConsumeScan();
  }, [createProductLine?.id, onConsumeScan, onNotify, scannedBarcode]);

  useEffect(() => {
    if (!open) return;
    try {
      const stored = localStorage.getItem("nutriplus-pending-intake-operation");
      // La comprobación pendiente se conserva fuera de React para sobrevivir una pérdida de conexión.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (stored) setPendingVerification(JSON.parse(stored) as { operationId: string; documentId: string; lineIds?: string[] });
    } catch { /* No hay comprobación pendiente válida. */ }
  }, [open]);

  const selectedLines = useMemo(() => lines.filter((line) => selected.has(line.id) && CONFIRMABLE.has(line.status) && line.action !== "pending" && pendingQuantity(line) > 0), [lines, selected]);
  const blockedSelected = useMemo(() => lines.filter((line) => selected.has(line.id) && !CONFIRMABLE.has(line.status)), [lines, selected]);
  const hasHistoricalMovements = useMemo(() => lines.some((line) => Boolean(
    line.movementHistory?.length
      || line.processedOperationId
      || Number(line.activeQuantity || 0) > 0
      || Number(line.reversedQuantity || 0) > 0,
  )), [lines]);
  const hasUnsavedChanges = metaDirty || dirtyLineIds.size > 0 || deletedLineIds.size > 0;
  const selectedInvoiceFile = invoiceFiles[selectedFileIndex] || invoiceFiles[0] || null;
  const documentPendingVerification = pendingVerification?.documentId === document?.id ? pendingVerification : null;

  const cancelDraftRequest = useCallback(async (documentId: string) => {
    return apiJson<{ canceled: boolean }>(await fetch(`/api/inventory-intake/${encodeURIComponent(documentId)}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }));
  }, []);

  async function cancelInvoiceReview(closeAfter = false, showNotice = true) {
    if (!document) {
      resetInvoiceReview();
      setTab("invoice");
      if (closeAfter) onClose();
      return true;
    }
    if (hasHistoricalMovements) {
      onNotify({ type: "error", text: "Esta factura ya tiene movimientos en el historial y no puede borrarse. Podés cerrarla sin perder el progreso o gestionar sus reversas desde el historial.", sticky: true });
      return false;
    }
    if (documentPendingVerification) {
      onNotify({ type: "error", text: "Primero comprobá el estado del ingreso pendiente antes de cancelar la factura.", sticky: true });
      return false;
    }
    setCanceling(true);
    try {
      await cancelDraftRequest(document.id);
      resetInvoiceReview();
      setTab("invoice");
      if (showNotice) onNotify({ type: "success", text: "El borrador sin movimientos fue eliminado. El inventario no cambió." });
      if (closeAfter) onClose();
      return true;
    } catch (error) {
      onNotify({ type: "error", text: intakeErrorText(error, "No se pudo eliminar el borrador. El inventario y el progreso anterior no cambiaron."), sticky: true });
      return false;
    } finally {
      setCanceling(false);
    }
  }

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const result = await apiJson<{ documents: IntakeHistoryDocument[]; operations: IntakeOperation[] }>(await fetch("/api/inventory-intake?history=1"));
      setHistory(result.operations);
      setHistoryDocuments(result.documents || []);
    } catch (error) {
      onNotify({ type: "error", text: intakeErrorText(error, "No se pudo cargar el historial."), sticky: true });
    } finally { setHistoryLoading(false); }
  }, [onNotify]);

  // Entrar a Historial dispara su sincronización con el servidor.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (open && tab === "history") void loadHistory(); }, [loadHistory, open, tab]);

  function applyLoadedResult(result: IntakeLoadResult) {
    const hydrated = (result.lines || []).map((line) => classifyLine(line, products, quotes));
    setDocument(result.document);
    setInvoiceFiles(result.files || []);
    setSelectedFileIndex(0);
    setAnalysis(result.analysis || null);
    setAnalyses(result.analyses || (result.analysis ? [result.analysis] : []));
    setAnalysisHistoryOpen(Boolean(result.analysis?.reviewRequired || (result.analyses || []).length > 1));
    setUsage(result.usage || null);
    setLines(hydrated);
    setSelected(new Set(hydrated.filter((line) => line.selectedForIngress && line.action !== "ignore" && line.status !== "processed").map((line) => line.id)));
    setDirtyLineIds(new Set());
    lineRevisionRef.current.clear();
    setDeletedLineIds(new Set());
    setMetaDirty(false);
    metaRevisionRef.current = 0;
    setInvoiceMode(result.document.processingMode === "chatgpt_import"
      ? "chatgpt_import"
      : result.document.processingMode === "ai" && !result.manualFallback ? "ai" : "manual");
    try { sessionStorage.setItem(ACTIVE_INVOICE_DRAFT_KEY, JSON.stringify({ documentId: result.document.id })); sessionStorage.removeItem(OPEN_INVOICE_REQUEST_KEY); } catch { /* Storage is optional. */ }
  }

  useEffect(() => {
    const openInvoice = (event: Event) => {
      const documentId = (event as CustomEvent<{ documentId?: string }>).detail?.documentId?.trim() || "";
      if (!open || !/^[A-Za-z0-9:_-]{1,160}$/.test(documentId)) return;
      resumeAttempted.current = true;
      try { sessionStorage.setItem(OPEN_INVOICE_REQUEST_KEY, documentId); } catch { /* Storage is optional. */ }
      void fetch(`/api/inventory-intake/${encodeURIComponent(documentId)}`)
        .then((response) => apiJson<IntakeLoadResult>(response))
        .then((result) => {
          applyLoadedResult(result);
          onNotify({ type: "info", text: "Abrimos la factura solicitada desde la alerta. Sus líneas y el archivo original siguen asociados al documento." });
        })
        .catch(() => {
          try { sessionStorage.removeItem(OPEN_INVOICE_REQUEST_KEY); } catch { /* Storage is optional. */ }
          onNotify({ type: "warning", text: "PROBLEMA: la factura de esta alerta ya no está disponible. CAUSA: fue eliminada, revertida o no puede abrirse ahora. QUÉ HACER: revisá el Historial de Facturas. ESTADO DE LOS DATOS: la alerta y los movimientos existentes se conservan." });
        });
    };
    window.addEventListener("nutriplus:open-invoice", openInvoice);
    return () => window.removeEventListener("nutriplus:open-invoice", openInvoice);
  // applyLoadedResult uses the current products/quotes of this mounted invoice review.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onNotify, open, products, quotes]);

  function addBlankManualLine() {
    const blank = emptyManualLine();
    setLines([blank]);
    setSelected(new Set([blank.id]));
    lineRevisionRef.current.set(blank.id, 1);
    setDirtyLineIds(new Set([blank.id]));
  }

  async function storedFilesForOcr() {
    if (uploadedFilesRef.current.length) return uploadedFilesRef.current;
    const downloaded: File[] = [];
    for (const file of invoiceFiles) {
      const response = await fetch(file.viewUrl);
      if (!response.ok) throw new Error(`No se pudo abrir “${file.fileName}” para la lectura de respaldo.`);
      downloaded.push(new File([await response.blob()], file.fileName, { type: file.mimeType }));
    }
    return downloaded;
  }

  async function runOcrFallback(sourceFiles?: File[], documentId?: string, automatic = false) {
    const targetId = documentId || document?.id;
    if (!targetId || ocrReading) return false;
    setOcrReading(true);
    try {
      const files = sourceFiles?.length ? sourceFiles : await storedFilesForOcr();
      if (!files.length) throw new Error("No se encontró el archivo para la lectura de respaldo.");
      const { readInvoiceFiles } = await import("@/lib/invoice-reader");
      const read = await readInvoiceFiles(files, (progress) => setReadProgress({
        current: progress.current,
        total: Math.max(1, progress.total),
        message: progress.message,
      }));
      const result = await apiJson<IntakeLoadResult>(await fetch(`/api/inventory-intake/${encodeURIComponent(targetId)}/fallback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pages: read.pages, warnings: read.warnings }),
      }));
      applyLoadedResult(result);
      if (!result.lines.length) addBlankManualLine();
      onNotify({
        type: result.lines.length ? "success" : "warning",
        text: result.lines.length
          ? `La lectura de respaldo encontró ${result.lines.length} producto${result.lines.length === 1 ? "" : "s"}. Revisalos manualmente.`
          : "La lectura de respaldo no encontró productos. La factura sigue guardada y podés agregarlos manualmente.",
        sticky: !result.lines.length,
      });
      return true;
    } catch (error) {
      onNotify({
        type: "error",
        text: `${intakeErrorText(error, "No se pudo completar la lectura de respaldo.")} La factura y el progreso continúan guardados en modo Manual.`,
        sticky: true,
      });
      if (automatic && !lines.length) addBlankManualLine();
      return false;
    } finally { setOcrReading(false); }
  }

  async function analyzeFiles(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = [...(event.currentTarget.files || [])];
    if (!files.length) return;
    if (document && hasUnsavedChanges) {
      onNotify({
        type: "warning",
        title: "Hay cambios sin guardar",
        text: "Guardá la revisión o cerrá la factura y descartá únicamente esos cambios antes de cambiar de factura. La factura guardada y el inventario no fueron modificados.",
        sticky: true,
      });
      input.value = "";
      return;
    }
    if (invoiceMode === "chatgpt_import" && files.length !== 1) {
      onNotify({ type: "error", title: "Paquete ZIP requerido", text: "Seleccioná un único archivo ZIP generado desde ChatGPT. No se creó ninguna factura ni se modificó el inventario.", sticky: true });
      input.value = "";
      return;
    }
    uploadedFilesRef.current = files;
    setReadProgress({
      current: 0,
      total: 1,
      message: invoiceMode === "ai"
        ? "Guardando y analizando la factura con IA…"
        : invoiceMode === "chatgpt_import" ? "Validando el ZIP y preparando el borrador…" : "Guardando la factura para revisión manual…",
    });
    setReading(true);
    if (invoiceMode !== "chatgpt_import") resetInvoiceReview();
    uploadedFilesRef.current = files;
    try {
      const form = new FormData();
      let endpoint = "/api/inventory-intake";
      if (invoiceMode === "chatgpt_import") {
        endpoint = "/api/inventory-intake/import-chatgpt";
        form.append("package", files[0], files[0].name);
      } else {
        form.set("mode", invoiceMode);
        files.forEach((file) => form.append("files", file, file.name));
      }
      const result = await apiJson<IntakeLoadResult>(await fetch(endpoint, { method: "POST", body: form }));
      applyLoadedResult(result);
      if (invoiceMode === "chatgpt_import" && result.recovered) {
        onNotify({
          type: result.notice?.type || "info",
          title: result.notice?.title || (result.recoveryState === "completed" ? "Factura ya procesada" : "Factura recuperada"),
          text: result.notice?.message || "Se recuperó la factura existente sin crear duplicados ni modificar el inventario.",
          sticky: true,
        });
      } else if (result.exactDuplicate) {
        onNotify({
          type: result.notice?.type || "info",
          title: result.notice?.title || "Factura recuperada",
          text: result.notice?.message || "Esta factura ya existía. Recuperamos su progreso actual sin crear duplicados ni modificar el inventario.",
          sticky: true,
        });
      } else if (result.cachedAnalysis) {
        onNotify({ type: "success", text: "Se recuperó el análisis y el avance guardados sin volver a generar consumo de OpenAI.", sticky: true });
      } else if (result.manualFallback) {
        onNotify({ type: "error", text: result.aiErrorMessage || "El análisis con IA falló. La factura se conservó y cambió al modo Manual.", sticky: true });
        await runOcrFallback(files, result.document.id, true);
      } else if (invoiceMode === "chatgpt_import") {
        onNotify({
          type: result.reviewRequired ? "warning" : "success",
          title: result.reviewRequired ? "Revisión requerida" : "Factura importada correctamente",
          text: result.reviewRequired
            ? `El paquete se importó como borrador con ${result.lines.length} productos y requiere revisión.`
            : `Análisis de ChatGPT importado: ${result.lines.length} productos en borrador, sin consumo de OpenAI API.`,
          sticky: result.reviewRequired,
        });
      } else if (invoiceMode === "manual") {
        if (!result.lines.length) addBlankManualLine();
        onNotify({ type: "success", text: "La factura quedó guardada en modo Manual. Podés completar los productos uno por uno." });
      } else if (result.reviewRequired || result.analysis?.reviewRequired) {
        onNotify({
          type: "warning",
          text: `Revisión requerida: Terra conservó ${result.lines.length} producto${result.lines.length === 1 ? "" : "s"}, pero detectó datos incompletos o inconsistentes. Revisalos antes de confirmar.`,
          sticky: true,
        });
      } else {
        onNotify({
          type: "success",
          text: `Análisis completado: ${result.lines.length} producto${result.lines.length === 1 ? "" : "s"}. Revisá y confirmá cada código antes de ingresar inventario.`,
          sticky: true,
        });
      }
    } catch (error) {
      const notice = intakeErrorNotice(error, "No se pudo importar la factura", invoiceMode === "chatgpt_import"
        ? "No se pudo importar el paquete de ChatGPT. No se creó ninguna factura ni se modificó el inventario."
        : "No se pudo guardar o analizar la factura. Revisá el archivo e intentá nuevamente.");
      onNotify({
        type: "error",
        title: notice.title,
        text: notice.text,
        sticky: true,
      });
    } finally {
      setReading(false);
      input.value = "";
    }
  }

  async function saveDraft(options: {
    showNotice?: boolean;
    reviewedLineIds?: Set<string>;
    onlyLineId?: string;
  } = {}) {
    if (!document || savingDraftRef.current) return false;
    const showNotice = options.showNotice !== false;
    const requestedReviewedLineIds = options.reviewedLineIds || new Set<string>();
    const lineIdsToSave = options.onlyLineId
      ? new Set([options.onlyLineId])
      : new Set([...dirtyLineIds, ...requestedReviewedLineIds]);
    const savedLineRevisions = new Map([...lineIdsToSave].map((id) => [id, lineRevisionRef.current.get(id) || 0]));
    const lineIdsToDelete = options.onlyLineId ? [] : [...deletedLineIds];
    const linesToSave = lines.filter((line) => lineIdsToSave.has(line.id)).map((line) => ({
      ...line,
      lineIndex: lines.findIndex((candidate) => candidate.id === line.id),
      selectedForIngress: selected.has(line.id),
    }));
    const reviewedLineIds = [...requestedReviewedLineIds].filter((id) => lineIdsToSave.has(id));
    const metadataChanged = options.onlyLineId ? false : metaDirty;
    const savedMetaRevision = metaRevisionRef.current;
    if (!metadataChanged && !linesToSave.length && !lineIdsToDelete.length) {
      if (showNotice) onNotify({ type: "success", text: "La revisión ya estaba guardada." });
      return true;
    }
    savingDraftRef.current = true;
    setSavingDraft(true);
    try {
      const result = await apiJson<{ lines: IntakeLineDto[]; reviewedLineIds: string[] }>(await fetch(`/api/inventory-intake/${document.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...document, metadataChanged, lines: linesToSave, deletedLineIds: lineIdsToDelete, reviewedLineIds }),
      }));
      const savedById = new Map(result.lines.map((line) => [line.id, line]));
      setLines((current) => current.map((line) => {
        const saved = savedById.get(line.id);
        return saved ? {
          ...line,
          selectedForIngress: saved.selectedForIngress,
          reviewSavedAt: saved.reviewSavedAt,
        } : line;
      }));
      setDirtyLineIds((current) => {
        const next = new Set(current);
        lineIdsToSave.forEach((id) => {
          if ((lineRevisionRef.current.get(id) || 0) === savedLineRevisions.get(id)) next.delete(id);
        });
        return next;
      });
      setDeletedLineIds((current) => {
        const next = new Set(current);
        lineIdsToDelete.forEach((id) => next.delete(id));
        return next;
      });
      if (metadataChanged && metaRevisionRef.current === savedMetaRevision) setMetaDirty(false);
      if (showNotice) onNotify({ type: "success", text: "La revisión quedó guardada sin modificar el inventario." });
      return true;
    } catch (error) {
      const message = intakeErrorText(error, "No se pudo guardar la revisión.");
      if (showNotice) {
        onNotify({ type: "error", text: message, sticky: true });
        return false;
      }
      throw new Error(message);
    } finally {
      savingDraftRef.current = false;
      setSavingDraft(false);
    }
  }

  useEffect(() => {
    const suspend = () => {
      // Changing module is not an explicit close. Persist the current review
      // and retain the document id so reopening Inventario resumes this exact
      // invoice instead of asking for the ZIP/PDF again.
      void saveDraft({ showNotice: false }).catch(() => undefined);
      onClose();
    };
    window.addEventListener("nutriplus:suspend-invoice", suspend);
    return () => window.removeEventListener("nutriplus:suspend-invoice", suspend);
  });

  async function saveOneLine(lineId: string) {
    if (savingLineId || savingDraftRef.current) return;
    setSavingLineId(lineId);
    try {
      const saved = await saveDraft({
        showNotice: false,
        reviewedLineIds: new Set([lineId]),
        onlyLineId: lineId,
      });
      if (saved) onNotify({ type: "success", text: "Este producto quedó guardado. El inventario todavía no fue modificado." });
    } catch (error) {
      onNotify({ type: "error", text: intakeErrorText(error, "No se pudo guardar este producto."), sticky: true });
    } finally {
      setSavingLineId(null);
    }
  }

  async function lookupCode(line: IntakeLineDto) {
    setLookupLineId(line.id);
    setLookupMessages((current) => ({ ...current, [line.id]: "Buscando la presentación exacta…" }));
    try {
      const result = await apiJson<{ candidates: CodeCandidate[]; message: string; failures: string[] }>(await fetch("/api/inventory-intake/lookup-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: line.name, presentation: line.presentation, provider: document?.provider, secondaryId: line.secondaryId, productUrl: "" }),
      }));
      setCandidates((current) => ({ ...current, [line.id]: result.candidates }));
      setLookupMessages((current) => ({ ...current, [line.id]: result.message }));
    } catch (error) {
      const message = intakeErrorText(error, "No se pudo buscar el código.");
      setLookupMessages((current) => ({ ...current, [line.id]: message }));
      onNotify({ type: "error", text: message, sticky: true });
    } finally { setLookupLineId(null); }
  }

  function confirmPendingBarcode() {
    if (!pendingBarcode) return;
    const checked = validateBarcode(pendingBarcode.code);
    if (!checked.valid || !checked.normalized) {
      onNotify({ type: "error", text: checked.error || "El código no es válido." });
      return;
    }
    updateLine(pendingBarcode.lineId, {
      barcode: checked.normalized,
      canonicalBarcode: checked.canonical || "",
      barcodeType: checked.type || "",
      barcodeMethod: pendingBarcode.method,
      barcodeSource: pendingBarcode.source,
      barcodeSourceUrl: pendingBarcode.sourceUrl || "",
      barcodeSourceTitle: pendingBarcode.sourceTitle || pendingBarcode.source,
      barcodeDifferences: pendingBarcode.differences || [],
      barcodeLookupStatus: pendingBarcode.differences?.length ? "suggestion" : "found_exact",
      barcodeConfirmed: true,
      warnings: [],
    });
    setPendingBarcode(null);
    setManualCodeLine(null);
    onNotify({ type: "success", text: `Código ${checked.normalized} confirmado para la vista previa.` });
  }

  function toggleBarcodeConfirmation(line: IntakeLineDto) {
    if (line.barcodeConfirmed) {
      updateLine(line.id, { barcodeConfirmed: false });
      onNotify({ type: "warning", text: `El código ${line.barcode} quedó como no confirmado.` });
      return;
    }
    const checked = validateBarcode(line.barcode);
    if (!checked.valid || !checked.normalized) {
      onNotify({ type: "error", text: checked.error || "Ingresá un código de barras válido.", sticky: true });
      return;
    }
    setPendingBarcode({
      lineId: line.id,
      code: checked.normalized,
      method: line.barcodeMethod || "manual",
      source: line.barcodeSource || "Escrito y confirmado manualmente",
      sourceUrl: line.barcodeSourceUrl,
      sourceTitle: line.barcodeSourceTitle,
      differences: line.barcodeDifferences,
    });
  }

  async function readLineImage(lineId: string, file: File) {
    try {
      const code = await readBarcodeImage(file);
      const checked = validateBarcode(code);
      if (!checked.valid || !checked.normalized) throw new Error(checked.error || "La imagen no contiene un código válido.");
      setPendingBarcode({ lineId, code: checked.normalized, method: "barcode_image", source: "Imagen del código físico" });
    } catch (error) {
      onNotify({ type: "error", text: intakeErrorText(error, "No se encontró un código de barras en la imagen."), sticky: true });
    }
  }

  async function pasteLineCode(lineId: string) {
    try {
      const value = (await navigator.clipboard.readText()).trim();
      const checked = validateBarcode(value);
      if (!checked.valid || !checked.normalized) throw new Error(checked.error || "El portapapeles no contiene un código válido.");
      setPendingBarcode({ lineId, code: checked.normalized, method: "clipboard", source: "Código pegado y confirmado" });
    } catch (error) {
      onNotify({ type: "error", text: intakeErrorText(error, "No se pudo leer el portapapeles."), sticky: true });
    }
  }

  function chooseMatch(line: IntakeLineDto, value: string) {
    if (!value) {
      updateLine(line.id, { matchProductId: null, matchNonInventoryId: null, match: null, action: "pending", status: "requires_select_product" });
      return;
    }
    const [source, idValue] = value.split(":");
    const id = Number(idValue);
    if (source === "inventory") {
      const product = products.find((item) => item.id === id);
      if (!product) return;
      updateLine(line.id, canonicalInventorySelection(product));
    } else {
      const quote = quotes.find((item) => item.id === id);
      if (!quote) return;
      updateLine(line.id, { matchProductId: null, matchNonInventoryId: id, action: "move", match: { source: "no_inventory", id, name: quote.name, code: quote.code, quantityAvailable: null, matchReason: "identity" } });
    }
  }

  function toggleLineSelection(line: IntakeLineDto) {
    const nextSelected = !selected.has(line.id);
    setSelected((current) => {
      const next = new Set(current);
      if (nextSelected) next.add(line.id);
      else next.delete(line.id);
      return next;
    });
    updateLine(line.id, { selectedForIngress: nextSelected }, false);
  }

  function clearPendingOperation(target: { operationId: string }) {
    try {
      const stored = localStorage.getItem("nutriplus-pending-intake-operation");
      const parsed = stored ? JSON.parse(stored) as { operationId?: string } : null;
      if (parsed?.operationId === target.operationId) localStorage.removeItem("nutriplus-pending-intake-operation");
    } catch { localStorage.removeItem("nutriplus-pending-intake-operation"); }
    setPendingVerification((current) => current?.operationId === target.operationId ? null : current);
  }

  async function verifyPendingOperation(target = documentPendingVerification) {
    if (!target) return;
    try {
      const response = await fetch(`/api/inventory-intake/operations/${encodeURIComponent(target.operationId)}`);
      if (response.status === 404) {
        clearPendingOperation(target);
        onNotify({ type: "warning", text: "El servidor confirmó que ese ingreso nunca se creó. Se retiró el bloqueo huérfano; la factura sigue abierta y el inventario no cambió.", sticky: true });
        return;
      }
      const result = await apiJson<{ operation: { status: string }; products: ProductRecord[]; movements?: Array<{ documentLineId?: string }> }>(response);
      if (result.operation.status === "completed") {
        onProductsChanged(result.products);
        await onRefresh();
        clearPendingOperation(target);
        onNotify({ type: "success", text: "El ingreso sí había sido completado y quedó verificado en el historial.", sticky: true });
        const confirmedLineIds = new Set((result.movements || []).map((movement) => movement.documentLineId).filter((value): value is string => Boolean(value)).concat(target.lineIds || []));
        if (document?.id === target.documentId) {
          setLines((current) => current.map((line) => confirmedLineIds.has(line.id) ? lineAfterConfirmation(line, target.operationId) : line));
          setSelected((current) => {
            const next = new Set(current);
            confirmedLineIds.forEach((lineId) => next.delete(lineId));
            return next;
          });
        }
      }
    } catch (error) {
      onNotify({ type: "error", text: `El ingreso continúa pendiente de comprobación: ${intakeErrorText(error, "no fue posible consultar el servidor.")}`, sticky: true });
    }
  }

  async function confirmIngreso(onlyLineId?: string) {
    const targetLines = onlyLineId ? selectedLines.filter((line) => line.id === onlyLineId) : selectedLines;
    const targetBlocked = onlyLineId
      ? lines.some((line) => line.id === onlyLineId && selected.has(line.id) && !CONFIRMABLE.has(line.status))
      : blockedSelected.length > 0;
    if (!document || confirmingRef.current || !targetLines.length || targetBlocked) return;
    confirmingRef.current = true;
    setConfirming(true);
    setConfirmingLineId(onlyLineId || null);
    const id = operationId("ingress");
    const pending = { operationId: id, documentId: document.id, lineIds: targetLines.map((line) => line.id) };
    let confirmationSent = false;
    try {
      const reviewSaved = await saveDraft({
        showNotice: false,
        reviewedLineIds: new Set(targetLines.map((line) => line.id)),
        onlyLineId,
      });
      if (!reviewSaved) throw new Error("No se pudo guardar la revisión antes de confirmar el ingreso.");
      localStorage.setItem("nutriplus-pending-intake-operation", JSON.stringify(pending));
      setPendingVerification(pending);
      confirmationSent = true;
      const result = await apiJson<{ operation: { id: string; status: string }; products?: ProductRecord[]; pendingVerification?: boolean }>(await fetch(`/api/inventory-intake/${document.id}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mutation-Id": id },
        body: JSON.stringify({ operationId: id, lines: targetLines.map((line) => ({
          ...line,
          requestedQuantity: pendingQuantity(line),
          selected: true,
        })) }),
      }));
      if (result.operation.status !== "completed" || result.pendingVerification) {
        onNotify({ type: "warning", text: "El servidor todavía está comprobando este ingreso. Esperá y usá “Comprobar estado”; la factura sigue guardada y NutriPlus no volverá a sumar las unidades.", sticky: true });
        return;
      }
      onProductsChanged(result.products || []);
      await onRefresh();
      const confirmedIds = new Set(targetLines.map((line) => line.id));
      setLines((current) => current.map((line) => confirmedIds.has(line.id) ? lineAfterConfirmation(line, id) : line));
      setSelected((current) => {
        const next = new Set(current);
        confirmedIds.forEach((lineId) => next.delete(lineId));
        return next;
      });
      localStorage.removeItem("nutriplus-pending-intake-operation");
      setPendingVerification(null);
      onNotify({
        type: "success",
        text: `${onlyLineId ? "Producto ingresado" : "Ingreso confirmado"}: ${targetLines.reduce((total, line) => total + pendingQuantity(line), 0)} unidades agregadas. Ningún precio fue modificado.`,
        sticky: true,
      });
      void loadHistory();
    } catch (error) {
      if (!confirmationSent) {
        onNotify({ type: "error", text: `${intakeErrorText(error, "No se pudo guardar la revisión.")} El ingreso no se inició y el inventario no cambió.`, sticky: true });
        return;
      }
      if (error instanceof IntakeApiError && error.status >= 400) {
        clearPendingOperation(pending);
        await onRefresh().catch(() => undefined);
        onNotify({
          type: "error",
          title: error.payload.title || "No se completó el ingreso",
          text: `${intakeErrorText(error, "No se pudo confirmar el ingreso.")} Corregí lo indicado y podés intentarlo nuevamente. ESTADO DE LOS DATOS: el servidor respondió y no existe un ingreso pendiente con este identificador; el inventario no se volverá a sumar.`,
          sticky: true,
        });
        return;
      }
      try {
        const response = await fetch(`/api/inventory-intake/operations/${encodeURIComponent(id)}`);
        if (response.ok) {
          const checked = await apiJson<{ operation: { status: string }; products: ProductRecord[] }>(response);
          if (checked.operation.status === "completed") {
            onProductsChanged(checked.products);
            await onRefresh();
            const confirmedIds = new Set(targetLines.map((line) => line.id));
            setLines((current) => current.map((line) => confirmedIds.has(line.id) ? lineAfterConfirmation(line, id) : line));
            setSelected((current) => {
              const next = new Set(current);
              confirmedIds.forEach((lineId) => next.delete(lineId));
              return next;
            });
            localStorage.removeItem("nutriplus-pending-intake-operation");
            setPendingVerification(null);
            onNotify({ type: "success", text: "El ingreso fue completado y verificado después del problema de conexión.", sticky: true });
            return;
          }
        }
        if (response.status === 404) {
          clearPendingOperation(pending);
          await onRefresh().catch(() => undefined);
          onNotify({
            type: "error",
            title: "El ingreso no se creó",
            text: `${intakeErrorText(error, "No se pudo confirmar el ingreso.")} El servidor confirmó que la transacción falló antes de guardar el movimiento. Corregí lo indicado y podés intentarlo nuevamente. ESTADO DE LOS DATOS: el inventario no cambió y no queda un bloqueo pendiente.`,
            sticky: true,
          });
          return;
        }
      } catch { /* La operación queda pendiente de comprobación manual. */ }
      onNotify({ type: "error", text: `${intakeErrorText(error, "No se pudo confirmar el ingreso.")} No lo repitás: usá “Comprobar estado” para verificar si se registró.`, sticky: true });
    } finally {
      confirmingRef.current = false;
      setConfirming(false);
      setConfirmingLineId(null);
    }
  }

  async function reanalyzeInvoice() {
    if (!document || reanalyzing || document.analysisStatus === "processing") return;
    setReanalyzing(true);
    setReadProgress({
      current: 0,
      total: 1,
      message: reanalyzeTarget === "sol" ? "Reanalizando la factura completa con Sol…" : "Analizando nuevamente la factura completa con IA…",
    });
    try {
      const result = await apiJson<IntakeLoadResult>(await fetch(`/api/inventory-intake/${encodeURIComponent(document.id)}/reanalyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true, model: reanalyzeTarget }),
      }));
      applyLoadedResult(result);
      setReanalyzeConfirmOpen(false);
      if (result.manualFallback) {
        onNotify({
          type: "error",
          text: `${result.aiErrorMessage || "El nuevo análisis no pudo completarse."} La factura y todo el avance previo continúan guardados.`,
          sticky: true,
        });
      } else if (result.reviewRequired || result.analysis?.reviewRequired) {
        onNotify({
          type: "warning",
          text: `Revisión requerida: ${result.analysis?.model || "el modelo"} conservó el resultado, pero detectó datos incompletos o inconsistentes. Revisá cada campo antes de confirmar.`,
          sticky: true,
        });
      } else {
        onNotify({
          type: "success",
          text: `Nuevo análisis completado con ${result.analysis?.model || "IA"}: ${result.lines.length} producto${result.lines.length === 1 ? "" : "s"}. Revisá los cambios antes de confirmar.`,
          sticky: true,
        });
      }
    } catch (error) {
      onNotify({
        type: "error",
        text: `${intakeErrorText(error, "No se pudo analizar nuevamente la factura.")} El archivo y la revisión anterior continúan guardados.`,
        sticky: true,
      });
    } finally { setReanalyzing(false); }
  }

  async function reverseOperation() {
    if (!reverseTarget || reverseReason.trim().length < 3 || reversing) return;
    setReversing(true);
    const id = operationId("reversal");
    try {
      const result = await apiJson<{ products: ProductRecord[] }>(await fetch(`/api/inventory-intake/operations/${reverseTarget.id}/reverse`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mutation-Id": id },
        body: JSON.stringify({ operationId: id, reason: reverseReason.trim() }),
      }));
      onProductsChanged(result.products);
      await onRefresh();
      if (document?.id === reverseTarget.documentId) {
        const refreshed = await apiJson<IntakeLoadResult>(await fetch(`/api/inventory-intake/${encodeURIComponent(document.id)}`));
        applyLoadedResult(refreshed);
      }
      setReverseTarget(null);
      setReverseReason("");
      await loadHistory();
      onNotify({ type: "success", text: "La reversión creó un movimiento contrario; el ingreso original permanece en el historial.", sticky: true });
    } catch (error) {
      onNotify({ type: "error", text: intakeErrorText(error, "No se pudo revertir el ingreso."), sticky: true });
    } finally { setReversing(false); }
  }

  function addManualLine() {
    const line = emptyManualLine();
    setLines((current) => [...current, line]);
    setSelected((current) => new Set(current).add(line.id));
    lineRevisionRef.current.set(line.id, 1);
    setDirtyLineIds((current) => new Set(current).add(line.id));
  }

  async function toggleLineOmission(line: IntakeLineDto) {
    if (!document || removingLineId) return;
    const currentlyIgnored = line.status === "ignored" || line.action === "ignore";
    const restoredAction: IntakeLineDto["action"] = line.matchProductId
      ? "existing" : line.matchNonInventoryId ? "move" : line.barcodeConfirmed ? "create" : "pending";
    const next = currentlyIgnored
      ? classifyLine({ ...line, action: restoredAction, status: "requires_confirm_code", selectedForIngress: true }, products, quotes)
      : { ...line, action: "ignore" as const, status: "ignored" as const, selectedForIngress: false };
    setRemovingLineId(line.id);
    try {
      const result = await apiJson<{ document?: IntakeDocument; lines: IntakeLineDto[] }>(await fetch(`/api/inventory-intake/${document.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metadataChanged: false,
          lines: [{ ...next, lineIndex: lines.findIndex((candidate) => candidate.id === line.id) }],
          deletedLineIds: [],
          reviewedLineIds: [line.id],
        }),
      }));
      const saved = result.lines[0] ? classifyLine(result.lines[0], products, quotes) : next;
      setLines((current) => current.map((candidate) => candidate.id === line.id ? saved : candidate));
      if (result.document) setDocument(result.document);
      setSelected((current) => {
        const updated = new Set(current);
        if (currentlyIgnored) updated.add(line.id);
        else updated.delete(line.id);
        return updated;
      });
      setDirtyLineIds((current) => {
        const updated = new Set(current);
        updated.delete(line.id);
        return updated;
      });
      lineRevisionRef.current.delete(line.id);
      onNotify({
        type: "success",
        text: currentlyIgnored
          ? "El producto volvió a quedar disponible para ingreso. La línea original y su historial se conservaron."
          : "El producto quedó omitido, pero sigue visible en la factura y podés reactivarlo después. El inventario no cambió.",
      });
    } catch (error) {
      onNotify({ type: "error", text: intakeErrorText(error, "No se pudo cambiar el estado de esta línea. El inventario no cambió."), sticky: true });
    } finally {
      setRemovingLineId(null);
    }
  }

  async function removeLineFromReview() {
    if (!removeLineTarget) return;
    if (removeLineTarget.isOriginalLine ?? !removeLineTarget.lineKey.startsWith("manual-")) {
      setRemoveLineTarget(null);
      await toggleLineOmission(removeLineTarget);
      return;
    }
    const lineId = removeLineTarget.id;
    setRemovingLineId(lineId);
    try {
      if (document) {
        await apiJson(await fetch(`/api/inventory-intake/${document.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ metadataChanged: false, lines: [], deletedLineIds: [lineId], reviewedLineIds: [] }),
        }));
      }
      setLines((current) => current.filter((line) => line.id !== lineId));
      setSelected((current) => {
        const next = new Set(current);
        next.delete(lineId);
        return next;
      });
      setDirtyLineIds((current) => {
        const next = new Set(current);
        next.delete(lineId);
        return next;
      });
      lineRevisionRef.current.delete(lineId);
      setCandidates((current) => {
        const next = { ...current };
        delete next[lineId];
        return next;
      });
      setLookupMessages((current) => {
        const next = { ...current };
        delete next[lineId];
        return next;
      });
      setRemoveLineTarget(null);
      onNotify({ type: "success", text: "La línea manual se eliminó. Las líneas originales de la factura no se modificaron." });
    } catch (error) {
      onNotify({ type: "error", text: intakeErrorText(error, "No se pudo eliminar este producto de la factura."), sticky: true });
    } finally {
      setRemovingLineId(null);
    }
  }

  function closeInvoiceView() {
    resetInvoiceReview();
    setTab("invoice");
    onClose();
  }

  function closeModal() {
    if (document && hasUnsavedChanges) {
      setCloseConfirmOpen(true);
      return;
    }
    closeInvoiceView();
  }

  if (!open) return null;
  return <div className="modal intake-modal" role="dialog" aria-modal="true" aria-label="Agregar inventario">
    <div className="intake-card">
      <header className="modal-head intake-head"><div><span className="eyebrow">Inventario NutriPlus</span><h2>Agregar inventario</h2><p>Las cantidades se suman a la existencia actual. Este proceso nunca cambia precios ni costos.</p></div><button className="icon-btn" onClick={closeModal} aria-label="Cerrar"><X /></button></header>
      <div className="intake-tabs" role="tablist">
        <button className={tab === "invoice" ? "active" : ""} onClick={() => setTab("invoice")}><FileText />Factura</button>
        <button className={tab === "quick" ? "active" : ""} onClick={() => setTab("quick")}><Barcode />Códigos</button>
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}><History />Historial</button>
      </div>

      {documentPendingVerification && <div className="alert warning intake-verification"><AlertCircle /><span>Hay un ingreso real de esta factura pendiente de comprobación. No lo confirmés de nuevo hasta revisar su estado.</span><button className="btn secondary small" onClick={() => void verifyPendingOperation()}>Comprobar estado</button></div>}

      {tab === "quick" && <section className="intake-pane quick-intake">
        <div className="intake-intro"><PackagePlus /><div><h3>Ingreso rápido por código</h3><p>Usá una línea por producto. La cantidad ingresada se <b>suma</b>; no reemplaza la existencia.</p></div></div>
        <div className="quick-example"><code>NP-001: 2</code><span>Si hay 10 disponibles, quedarán 12.</span></div>
        <textarea className="quantity-input" value={quickText} onChange={(event) => setQuickText(event.target.value)} placeholder={"NP-001: 2\n7501234567890: 5"} autoFocus />
        <div className="alert success"><ShieldCheck /><span>La suma utiliza la existencia más reciente y un identificador único para evitar duplicados al reintentar.</span></div>
        <div className="confirm-actions"><button className="btn secondary" onClick={closeModal}>Cancelar</button><button className="btn primary" onClick={onQuickSave} disabled={!quickText.trim()}><PackagePlus />Agregar cantidades</button></div>
      </section>}

      {tab === "invoice" && <section className="intake-pane invoice-intake">
        {!document && !reading && <div className="invoice-start">
          <div className="invoice-mode-picker" aria-label="Modo de lectura de factura">
            <button type="button" className={invoiceMode === "ai" ? "active" : ""} onClick={() => setInvoiceMode("ai")} disabled={Boolean(aiConfig && !aiConfig.aiAvailable)}>
              <span className="mode-icon"><Bot /></span>
              <span><b>Automático con IA</b><small>Lee el PDF o las imágenes completas, identifica productos y busca códigos exactos en la web.</small></span>
              <em>{!aiConfig ? "Consultando disponibilidad…" : aiConfig.aiAvailable ? `Disponible · ${aiConfig.model}` : aiConfig.limitReached ? "Límite mensual alcanzado" : aiConfig.aiEnabled ? "Clave no disponible" : "Desactivado"}</em>
            </button>
            <button type="button" className={invoiceMode === "manual" ? "active" : ""} onClick={() => setInvoiceMode("manual")}>
              <span className="mode-icon"><FileSearch /></span>
              <span><b>Manual</b><small>Guarda la factura sin llamar a OpenAI. Podés escribir cada producto o usar la lectura OCR de respaldo.</small></span>
              <em>Sin consumo de IA</em>
            </button>
            <button type="button" className={invoiceMode === "chatgpt_import" ? "active" : ""} onClick={() => setInvoiceMode("chatgpt_import")}>
              <span className="mode-icon"><FileArchive /></span>
              <span><b>Importar análisis de ChatGPT</b><small>Valida un ZIP con analysis.json y una única factura, y crea un borrador para revisión.</small></span>
              <em>API calls 0 · Costo $0.00</em>
            </button>
          </div>
          {aiConfig && invoiceMode === "ai" && <div className="ai-budget-note"><Sparkles /><span>Consumo del mes: <b>{costLabel(aiConfig.currentMonthCostUsd)}</b> de {costLabel(aiConfig.monthlyLimitUsd)} · acumulado {costLabel(aiConfig.cumulativeCostUsd)}</span></div>}
          <label className="surface invoice-upload"><span className="upload-icon"><Upload /></span><h3>{invoiceMode === "chatgpt_import" ? "Subir paquete ZIP" : "Subir factura"}</h3><p>{invoiceMode === "chatgpt_import" ? "Debe contener analysis.json y exactamente una factura invoice.pdf, invoice.jpg, invoice.jpeg, invoice.png o invoice.webp." : "PDF, fotografías, capturas y documentos de varias páginas. Se guardan antes de iniciar cualquier análisis."}</p><span className="btn primary">{invoiceMode === "chatgpt_import" ? <FileArchive /> : <FileText />}{invoiceMode === "chatgpt_import" ? "Elegir ZIP" : "Elegir archivos"}</span><input className="native-file-input" type="file" accept={invoiceMode === "chatgpt_import" ? ".zip,application/zip,application/x-zip-compressed" : "application/pdf,image/*"} multiple={invoiceMode !== "chatgpt_import"} onChange={analyzeFiles} /></label>
        </div>}
        {reading && <div className="surface invoice-reading"><Loader2 className="spin" /><h3>{invoiceMode === "ai" ? "Analizando la factura" : invoiceMode === "chatgpt_import" ? "Importando análisis de ChatGPT" : "Guardando la factura"}</h3><p>{readProgress.message}</p>{ocrReading && <><div className="progress"><span style={{ width: `${Math.round(readProgress.current / Math.max(1, readProgress.total) * 100)}%` }} /></div><b>{Math.round(readProgress.current / Math.max(1, readProgress.total) * 100)}%</b></>}</div>}
        {document && !reading && <>
          <div className="surface invoice-summary">
            <div className="invoice-summary-head">
              <div><span className="eyebrow">Vista previa obligatoria</span><h3>{document.fileName}</h3><p>{document.pageCount} página{document.pageCount === 1 ? "" : "s"} · {document.fileCount || invoiceFiles.length} archivo{(document.fileCount || invoiceFiles.length) === 1 ? "" : "s"} · {lines.length} producto{lines.length === 1 ? "" : "s"}</p></div>
              <div className="invoice-summary-actions">
                {document.processingMode === "manual" && <button className="btn secondary small" onClick={() => void runOcrFallback()} disabled={ocrReading || reanalyzing}><FileSearch />{ocrReading ? "Leyendo…" : "Extraer con OCR (sin IA)"}</button>}
                {document.processingMode !== "chatgpt_import" && <button className="btn secondary small" onClick={() => { setReanalyzeTarget("primary"); setReanalyzeConfirmOpen(true); }} disabled={reanalyzing || !aiConfig?.aiAvailable || document.analysisStatus === "processing" || !invoiceFiles.length}><Sparkles />{reanalyzing ? "Analizando…" : "Analizar nuevamente"}</button>}
                {analysis?.analysisOrigin !== "CHATGPT_IMPORT" && (analysis?.reviewRequired || document.analysisStatus === "review_required") && !analysis?.model.startsWith("gpt-5.6-sol") && <button className="btn secondary small sol-reanalysis-button" onClick={() => { setReanalyzeTarget("sol"); setReanalyzeConfirmOpen(true); }} disabled={reanalyzing || !aiConfig?.aiAvailable || document.analysisStatus === "processing" || !invoiceFiles.length}><Sparkles />Reanalizar con Sol</button>}
                <label className="btn secondary small"><Upload />Cambiar factura<input className="native-file-input" type="file" accept={document.processingMode === "chatgpt_import" ? ".zip,application/zip,application/x-zip-compressed" : "application/pdf,image/*"} multiple={document.processingMode !== "chatgpt_import"} onChange={analyzeFiles} /></label>
              </div>
            </div>

            {selectedInvoiceFile && <div className="invoice-file-panel">
              {invoiceFiles.length > 1 && <div className="invoice-file-tabs">{invoiceFiles.map((file, index) => <button type="button" className={selectedFileIndex === index ? "active" : ""} onClick={() => setSelectedFileIndex(index)} key={file.id}><FileText />{file.fileName}</button>)}</div>}
              <div className="invoice-file-viewer">
                {selectedInvoiceFile.mimeType === "application/pdf"
                  ? <iframe src={selectedInvoiceFile.viewUrl} title={`Factura ${selectedInvoiceFile.fileName}`} />
                  : <img src={selectedInvoiceFile.viewUrl} alt={`Factura ${selectedInvoiceFile.fileName}`} />}
              </div>
              <a className="invoice-open-file" href={selectedInvoiceFile.viewUrl} target="_blank" rel="noreferrer"><FileSearch />Abrir archivo completo</a>
            </div>}

            <div className={`analysis-overview ${document.processingMode}`}>
              <div className="analysis-mode"><span>{document.processingMode === "ai" ? <Bot /> : document.processingMode === "chatgpt_import" ? <FileArchive /> : <FileSearch />}</span><div><small>Modo actual</small><b>{document.processingMode === "ai" ? "Automático con IA" : document.processingMode === "chatgpt_import" ? "Importar análisis de ChatGPT" : "Manual"}</b></div></div>
              {analysis ? <>
                <div><small>Origen</small><b>{analysisOriginLabel(analysis.analysisOrigin)}</b></div>
                <div><small>Estado</small><b className={`analysis-status-text ${analysis.status}`}>{analysisStatusLabel(analysis.status)}</b></div>
                {analysis.analysisOrigin === "CHATGPT_IMPORT" ? <>
                  <div><small>Llamadas API</small><b>{analysis.apiCalls}</b></div>
                  <div><small>Costo API</small><b>{costLabel(analysis.apiCostUsd)}</b></div>
                  {analysis.importSummary && <><div><small>Moneda y total</small><b>{importedMoney(analysis.importSummary.total, analysis.importSummary.currency)}</b><em>Subtotal {importedMoney(analysis.importSummary.subtotal, analysis.importSummary.currency)}</em></div><div><small>Contenido validado</small><b>{analysis.importSummary.lineCount} líneas · {analysis.importSummary.inventoryUnits} unidades</b></div></>}
                </> : <>
                  <div><small>Modelo</small><b>{analysis.model || "—"}</b></div>
                  <div><small>Tokens</small><b>{analysis.totalTokens.toLocaleString("es-CR")}</b><em>{analysis.inputTokens.toLocaleString("es-CR")} entrada · {analysis.outputTokens.toLocaleString("es-CR")} salida · {analysis.cachedInputTokens.toLocaleString("es-CR")} en caché</em></div>
                  <div><small>Búsquedas web</small><b>{analysis.webSearchCount}</b></div>
                  <div><small>Costo estimado de este análisis</small><b>{costLabel(analysis.estimatedCostUsd)}</b></div>
                </>}
                <div><small>Fecha y hora</small><b>{analysisDateLabel(analysis.completedAt || analysis.createdAt)}</b></div>
              </> : <div className="analysis-manual-note"><small>Análisis de OpenAI</small><b>No realizado</b></div>}
              {usage && <div><small>Costo acumulado</small><b>{costLabel(usage.cumulativeCostUsd)}</b><em>{usage.billedAnalyses} análisis con consumo</em></div>}
            </div>
            {analysis?.reviewRequired && <div className="analysis-review-alert"><AlertCircle /><div><b>Revisión requerida</b><p>{analysis.analysisOrigin === "CHATGPT_IMPORT" ? "El paquete se conservó como borrador, pero contiene productos marcados para revisión. Revisá la factura y cada producto antes de confirmar." : "El resultado se conservó, pero Terra detectó datos incompletos o inconsistentes. Revisá la factura y cada producto. No se ejecutará Sol automáticamente."}</p></div></div>}
            {analyses.length > 0 && <details className="analysis-history" open={analysisHistoryOpen} onToggle={(event) => setAnalysisHistoryOpen(event.currentTarget.open)}>
              <summary><History />Historial de análisis ({analyses.length})</summary>
              <div className="analysis-history-list">{analyses.slice().reverse().map((item) => <article key={item.id}>
                <header><span><b>Análisis #{item.analysisNumber}</b><small>{item.analysisOrigin === "CHATGPT_IMPORT" ? "Análisis importado" : item.reanalysis ? "Reanálisis" : "Análisis inicial"}</small></span><span className={`analysis-status-pill ${item.status}`}>{analysisStatusLabel(item.status)}</span></header>
                <div><span><small>Origen</small><b>{analysisOriginLabel(item.analysisOrigin)}</b></span>{item.analysisOrigin === "CHATGPT_IMPORT" ? <><span><small>Llamadas API</small><b>{item.apiCalls}</b></span><span><small>Costo API</small><b>{costLabel(item.apiCostUsd)}</b></span></> : <><span><small>Modelo utilizado</small><b>{item.model || "—"}</b></span><span><small>Tokens</small><b>{item.totalTokens.toLocaleString("es-CR")}</b><small>{item.inputTokens.toLocaleString("es-CR")} entrada · {item.outputTokens.toLocaleString("es-CR")} salida · {item.cachedInputTokens.toLocaleString("es-CR")} caché</small></span><span><small>Búsquedas web</small><b>{item.webSearchCount}</b></span><span><small>Costo individual</small><b>{costLabel(item.estimatedCostUsd)}</b></span></>}<span><small>Fecha y hora</small><b>{analysisDateLabel(item.completedAt || item.createdAt)}</b></span><span><small>Acumulado de esta factura</small><b>{costLabel(item.cumulativeCostUsd)}</b></span></div>
                {item.errorMessage && <p>{item.errorMessage}</p>}
              </article>)}</div>
            </details>}
            <div className="invoice-meta-grid">
              <label><span>Proveedor</span><select value={document.provider} onChange={(event) => updateDocumentMeta({ provider: event.target.value as IntakeDocument["provider"] })}><option value="amazon">Amazon</option><option value="iherb">iHerb</option><option value="other">Otra tienda</option></select></label>
              <label><span>Número de pedido</span><input value={document.orderNumber} onChange={(event) => updateDocumentMeta({ orderNumber: event.target.value })} placeholder="Pedido, compra u orden" /></label>
              <label><span>Fecha</span><input value={document.documentDate} onChange={(event) => updateDocumentMeta({ documentDate: event.target.value })} placeholder="Fecha de compra o pedido" /></label>
              <label><span>Número de rastreo o envío</span><input value={document.shipmentNumber} onChange={(event) => updateDocumentMeta({ shipmentNumber: event.target.value })} placeholder="Si aparece en la factura" /></label>
            </div>
            {evidenceEntries(document.fieldEvidence).length > 0 && <div className="evidence-strip"><span><FileSearch />Evidencia del documento</span><div>{evidenceEntries(document.fieldEvidence).map(([field, item]) => <small key={field}><b>{EVIDENCE_LABELS[field] || field}</b>{item.page ? `p. ${item.page}` : "sin página"} · {item.confidence ?? 0}%</small>)}</div></div>}
            <div className="alert success"><ShieldCheck /><span>Los precios, costos, peso, courier, entrega, Correos, ganancias y tipo de cambio están excluidos de esta pantalla y de la actualización.</span></div>
            {document.warnings.map((warning) => <div className="alert warning" key={warning}><AlertCircle />{warning}</div>)}
          </div>

          <div className="invoice-lines-head"><div><h3>Productos reconocidos</h3><p>Confirmá código, producto, presentación y cantidad físicamente recibida.</p></div><button className="btn secondary small" onClick={addManualLine}><Plus />Agregar línea</button></div>
          <div className="invoice-preview-table" role="table" aria-label="Vista previa del ingreso de inventario">
            {lines.map((line, index) => {
              const currentQuantity = line.match?.quantityAvailable ?? 0;
              const originalQuantity = Math.max(0, Number(line.originalQuantity ?? line.totalToAdd));
              const activeQuantity = Math.max(0, Number(line.activeQuantity || 0));
              const availableQuantity = pendingQuantity(line);
              const resultingQuantity = currentQuantity + availableQuantity;
              const lineCandidates = candidates[line.id] || [];
              const isSelected = selected.has(line.id);
              const isIgnored = line.status === "ignored" || line.action === "ignore";
              const isOriginalLine = line.isOriginalLine ?? !line.lineKey.startsWith("manual-");
              const hasActiveInventory = activeQuantity > 0;
              const matchChoices = matchPickerLineId === line.id ? pickerResults(line, products, quotes, matchQuery) : [];
              const showLineDetails = isSelected || line.status === "processed" || isIgnored;
              return <article className={`invoice-line status-${line.status} ${showLineDetails ? "selected" : "excluded"}`} key={line.id}>
                <div className="invoice-line-top"><label className="product-selector"><input type="checkbox" checked={isSelected} disabled={line.status === "processed" || isIgnored} onChange={() => toggleLineSelection(line)} /><span><Check /></span></label><div><div className="line-statuses"><span className={`status-pill ${line.status}`}>{isIgnored || line.status === "processed" ? STATUS_LABELS[line.status] : isSelected ? STATUS_LABELS[line.status] : "No seleccionado"}</span>{line.reviewSavedAt && <span className="review-saved-pill"><Save />Progreso guardado</span>}</div><small>Línea {index + 1}{line.pageNumber ? ` · página ${line.pageNumber}` : " · manual"}</small></div>{isOriginalLine ? <button className="btn ghost small line-omit-btn" onClick={() => void toggleLineOmission(line)} disabled={activeQuantity > 0 || removingLineId === line.id}>{removingLineId === line.id ? <Loader2 className="spin" /> : isIgnored ? <RotateCcw /> : <X />}{isIgnored ? "Reactivar" : activeQuantity > 0 ? "Ya ingresado" : "Omitir"}</button> : <button className="icon-btn danger" onClick={() => setRemoveLineTarget(line)} aria-label="Eliminar línea manual" disabled={line.status === "processed" || removingLineId === line.id}><X /></button>}</div>
                <div className="invoice-line-grid">
                  <div className="wide invoice-source-fields"><b>Datos originales de factura</b><small>Se conservan para trazabilidad y comparación; no reemplazan el producto interno seleccionado.</small></div>
                  <label className="wide"><span>Producto de la factura</span><input value={line.name} disabled={hasActiveInventory || isIgnored} onChange={(event) => updateLine(line.id, { name: event.target.value }, false)} /></label>
                  <label><span>Marca</span><input value={line.brand} disabled={hasActiveInventory || isIgnored} onChange={(event) => updateLine(line.id, { brand: event.target.value }, false)} /></label>
                  <label><span>Presentación</span><input value={line.presentation} disabled={hasActiveInventory || isIgnored} onChange={(event) => updateLine(line.id, { presentation: normalizePresentation(event.target.value) || event.target.value }, false)} /></label>
                  <label><span>Tamaño / contenido</span><input value={line.size} disabled={hasActiveInventory || isIgnored} onChange={(event) => updateLine(line.id, { size: event.target.value }, false)} /></label>
                  <label><span>{document.provider === "amazon" ? "ASIN" : document.provider === "iherb" ? "Código iHerb" : "Identificador proveedor"}</span><input value={line.secondaryId} disabled={hasActiveInventory || isIgnored} onChange={(event) => updateLine(line.id, { secondaryId: event.target.value, secondaryType: document.provider === "amazon" ? "asin" : document.provider === "iherb" ? "iherb" : "other" }, false)} /></label>
                  <div className="wide product-match-picker"><span>Producto de NutriPlus</span>{line.match && <div className="canonical-product-card"><b>Coincide con producto existente · {line.match.name}</b><small>{line.match.code ? `Código ${line.match.code}` : "Sin código canónico"}{line.match.brand ? ` · ${line.match.brand}` : ""}{line.match.presentation ? ` · ${line.match.presentation}` : ""}</small><small>Stock actual {line.match.quantityAvailable ?? 0}{line.match.minimumStockEnabled ? ` · mínimo ${line.match.minimumStock ?? 0}` : " · sin mínimo"}</small>{line.match.source === "inventory" && !hasActiveInventory && <button type="button" className="btn ghost small" onClick={() => onEditProduct(line.match!.id)}>Editar producto canónico</button>}</div>}<button type="button" className="btn secondary small" disabled={hasActiveInventory || isIgnored} onClick={() => { setMatchPickerLineId(matchPickerLineId === line.id ? null : line.id); setMatchQuery(""); }}><Search />{line.match ? "Cambiar producto existente" : "Seleccionar producto existente"}</button>{!hasActiveInventory && !isIgnored && !line.matchProductId && <button type="button" className="btn secondary small inline-product-create" onClick={() => openCreateProduct(line)}><PackagePlus />Crear producto nuevo</button>}{matchPickerLineId === line.id && <div className="product-match-results"><input autoFocus value={matchQuery} onChange={(event) => setMatchQuery(event.target.value)} placeholder="Buscar nombre, marca, presentación o código" /><div>{matchChoices.map((choice) => <button type="button" key={`${choice.source}:${choice.product.id}`} onClick={() => { chooseMatch(line, `${choice.source}:${choice.product.id}`); setMatchPickerLineId(null); setMatchQuery(""); }}><b>{choice.product.name}</b><small>{choice.product.code ? `Código ${choice.product.code}` : "Sin código"}{"brand" in choice.product && choice.product.brand ? ` · ${choice.product.brand}` : ""}{"presentation" in choice.product && choice.product.presentation ? ` · ${choice.product.presentation}` : ""}</small></button>)}{!matchChoices.length && <p>No encontramos productos con esas palabras. Revisá marca, presentación o código; la factura no cambió.</p>}</div></div>}</div>
                  <label><span>Cantidad facturada</span><input inputMode="numeric" value={line.billedQuantity ?? ""} disabled={hasActiveInventory || isIgnored} onChange={(event) => updateLine(line.id, { billedQuantity: event.target.value === "" ? null : Number(event.target.value) }, false)} /></label>
                  <label><span>Cantidad recibida</span><input inputMode="numeric" value={line.receivedQuantity ?? ""} disabled={hasActiveInventory || isIgnored} onChange={(event) => updateLine(line.id, { receivedQuantity: event.target.value === "" ? null : Math.max(0, Number(event.target.value) || 0) })} /></label>
                  <label><span>Unidades por paquete</span><input inputMode="numeric" value={line.unitsPerPackage} disabled={hasActiveInventory || isIgnored} onChange={(event) => updateLine(line.id, { unitsPerPackage: Math.max(1, Number(event.target.value) || 1), barcodeLevel: Number(event.target.value) > 1 ? line.barcodeLevel : "unit" })} /></label>
                  {line.unitsPerPackage > 1 && <label><span>Nivel del código</span><select disabled={hasActiveInventory || isIgnored} value={line.barcodeLevel} onChange={(event) => updateLine(line.id, { barcodeLevel: event.target.value as IntakeLineDto["barcodeLevel"] })}><option value="">Confirmar nivel</option><option value="unit">Unidad individual</option><option value="package">Paquete completo</option><option value="distribution">Caja de distribución</option><option value="set">Set de productos</option></select></label>}
                  <label className="wide barcode-field"><span>UPC / EAN / GTIN</span><div><input value={line.barcode} inputMode="numeric" disabled={hasActiveInventory || isIgnored} onChange={(event) => updateLine(line.id, { barcode: event.target.value, barcodeConfirmed: false })} placeholder="Código pendiente" /><button disabled={hasActiveInventory || isIgnored} className={`btn small ${line.barcodeConfirmed ? "primary" : "danger-outline"}`} onClick={() => toggleBarcodeConfirmation(line)}><Check />{line.barcodeConfirmed ? "Código confirmado" : "Confirmar código de barras"}</button></div></label>
                </div>
                {!isIgnored && !hasActiveInventory && (!line.barcodeConfirmed || ["requires_confirm_code", "conflict_identifiers"].includes(line.status)) && <div className="code-pending-box"><p><b>El código de barras está pendiente de confirmación.</b> Seleccioná una opción para continuar.</p><div><button className="btn secondary small" onClick={() => onRequestScan(line.id)}><Camera />Escanear código</button><label className="btn secondary small"><ImageUp />Subir imagen<input className="native-file-input" type="file" accept="image/*" onChange={(event) => { const input = event.currentTarget; const file = input.files?.[0]; if (file) void readLineImage(line.id, file).finally(() => { input.value = ""; }); }} /></label><button className="btn secondary small" onClick={() => void pasteLineCode(line.id)}><ClipboardPaste />Pegar código</button><button className="btn secondary small" onClick={() => setManualCodeLine(manualCodeLine === line.id ? null : line.id)}><Barcode />Escribir código</button><button className="btn ghost small" onClick={() => void lookupCode(line)} disabled={lookupLineId === line.id}>{lookupLineId === line.id ? <Loader2 className="spin" /> : <Search />}Buscar código</button></div>{manualCodeLine === line.id && <div className="manual-code-row"><input value={line.barcode} inputMode="numeric" onChange={(event) => updateLine(line.id, { barcode: event.target.value, barcodeConfirmed: false })} placeholder="Escribí 8, 12, 13 o 14 dígitos" /><button className="btn primary small" onClick={() => toggleBarcodeConfirmation(line)}>Revisar</button></div>}</div>}
                {lookupMessages[line.id] && <div className={`lookup-results ${lineCandidates.length ? "has-results" : ""}`}><p>{lookupMessages[line.id]}</p>{lineCandidates.map((candidate) => <button key={`${candidate.code}-${candidate.source}`} onClick={() => setPendingBarcode({ lineId: line.id, code: candidate.code, method: "external_source", source: candidate.source, sourceUrl: candidate.sourceUrl, sourceTitle: candidate.title, differences: candidate.differences })}><span><b>{candidate.code} · {candidate.type}</b><small>{candidate.title}{candidate.presentation ? ` · ${candidate.presentation}` : ""}</small>{candidate.differences.map((difference) => <em key={difference}>{difference}</em>)}</span><strong>{candidate.confidence}%<small>Confirmar</small></strong></button>)}</div>}
                {(line.barcodeSource || line.barcodeSourceUrl) && <div className={`barcode-source-card ${line.barcodeDifferences.length ? "warning" : ""}`}><FileSearch /><div><small>Fuente del código de barras</small>{line.barcodeSourceUrl ? <a href={line.barcodeSourceUrl} target="_blank" rel="noreferrer">{line.barcodeSourceTitle || line.barcodeSource || "Abrir fuente consultada"}</a> : <b>{line.barcodeSourceTitle || line.barcodeSource}</b>}{line.barcodeDifferences.map((difference) => <em key={difference}>{difference}</em>)}</div><span>{line.barcodeLookupStatus === "found_exact" ? "Coincidencia exacta" : line.barcodeLookupStatus === "suggestion" ? "Revisar diferencias" : "Pendiente"}</span></div>}
                {evidenceEntries(line.fieldEvidence).length > 0 && <div className="evidence-strip line-evidence"><span><FileSearch />Evidencia de extracción</span><div>{evidenceEntries(line.fieldEvidence).map(([field, item]) => <small key={field}><b>{EVIDENCE_LABELS[field] || field}</b>{item.page ? `p. ${item.page}` : "sin página"} · {item.confidence ?? 0}%</small>)}</div></div>}
                {line.warnings.map((warning) => <div className="alert warning line-warning" key={warning}><AlertCircle />{warning}</div>)}
                <div className="quantity-preview line-progress-preview"><span><small>Cantidad de factura</small><b>{originalQuantity}</b></span><span><small>Ya agregadas</small><b>{activeQuantity}</b></span><span><small>Pendientes</small><b>{isIgnored ? 0 : availableQuantity}</b></span><span><small>Existencia al ingresar pendientes</small><b>{line.match?.source === "inventory" || ["move", "create"].includes(line.action) ? resultingQuantity : "—"}</b></span></div>
                {activeQuantity > 0 && availableQuantity === 0 && <div className="alert success"><Check />Este producto ya fue agregado completamente al inventario: {activeQuantity} de {originalQuantity} unidades.</div>}
                {activeQuantity > 0 && availableQuantity > 0 && <div className="alert warning"><AlertCircle />Ya se agregaron {activeQuantity} de {originalQuantity} unidades. Podés ingresar las {availableQuantity} unidades pendientes.</div>}
                {line.hasReversals && <div className="alert warning"><RotateCcw />Esta línea tiene reversas en el historial. El saldo disponible se calculó usando todos sus movimientos.</div>}
                {line.progressInconsistent && <div className="alert error"><AlertCircle />El historial de cantidades necesita revisión. No confirmés esta línea hasta verificar sus movimientos.</div>}
                {line.status === "non_inventory" && <div className="alert success"><PackagePlus />Al confirmar: Mover a inventario y agregar cantidad. Sus precios y demás datos permanecerán sin cambios.</div>}
                {line.status !== "processed" && !isIgnored && <div className="line-save-actions">
                  <div>{line.status === "new_product" && <p><b>Producto nuevo:</b> se creará en Inventario sin precios únicamente cuando confirmés el ingreso.</p>}{line.reviewSavedAt && !dirtyLineIds.has(line.id) && <small>Si cerrás la página, este avance se recuperará al volver a subir la factura.</small>}</div>
                  <div className="line-action-buttons">
                    <button className={`btn small ${line.reviewSavedAt && !dirtyLineIds.has(line.id) ? "success-static" : "secondary"}`} onClick={() => void saveOneLine(line.id)} disabled={!isSelected || savingDraft || confirming || line.reviewSavedAt !== "" && !dirtyLineIds.has(line.id)}>{savingLineId === line.id ? <Loader2 className="spin" /> : line.reviewSavedAt && !dirtyLineIds.has(line.id) ? <Check /> : <Save />}{line.reviewSavedAt && !dirtyLineIds.has(line.id) ? "Producto guardado" : line.reviewSavedAt ? "Guardar cambios" : "Guardar producto"}</button>
                    <button className="btn primary small" onClick={() => void confirmIngreso(line.id)} disabled={!isSelected || confirming || savingDraft || !CONFIRMABLE.has(line.status) || line.action === "pending" || availableQuantity <= 0 || Boolean(documentPendingVerification)}>{confirmingLineId === line.id ? <Loader2 className="spin" /> : <ShieldCheck />}{confirmingLineId === line.id ? "Ingresando…" : `Ingresar este producto (+${availableQuantity})`}</button>
                  </div>
                </div>}
              </article>;
            })}
          </div>
          <p className="split-help">Para distribuir un set entre productos diferentes, agregá una línea manual por componente y marcá la línea original como Omitida. Así siempre quedará disponible para auditoría o reactivación.</p>
          {blockedSelected.length > 0 && <div className="alert error"><AlertCircle />{blockedSelected.length} línea{blockedSelected.length === 1 ? " seleccionada necesita" : "s seleccionadas necesitan"} revisión antes de confirmar.</div>}
          <div className="intake-footer"><button className="btn secondary" onClick={closeModal} disabled={canceling || confirming}><X />Cerrar factura</button>{!hasHistoricalMovements && <button className="btn danger-outline" onClick={() => setCancelConfirmOpen(true)} disabled={canceling || confirming || Boolean(documentPendingVerification)}>Eliminar borrador</button>}<button className="btn secondary" onClick={() => void saveDraft({ reviewedLineIds: new Set(lines.filter((line) => selected.has(line.id) && line.status !== "processed").map((line) => line.id)) })} disabled={savingDraft || confirming}>{savingDraft && !savingLineId ? <Loader2 className="spin" /> : <Save />}Guardar toda la revisión</button><button className="btn primary" onClick={() => void confirmIngreso()} disabled={confirming || savingDraft || !selectedLines.length || blockedSelected.length > 0 || Boolean(documentPendingVerification)}>{confirming ? <Loader2 className="spin" /> : <ShieldCheck />}Confirmar ingreso ({selectedLines.reduce((total, line) => total + pendingQuantity(line), 0)} unidades)</button></div>
        </>}
      </section>}

      {tab === "history" && <section className="intake-pane intake-history">
        <div className="intake-intro"><FileClock /><div><h3>Historial de facturas</h3><p>Una entrada por factura, con todas sus líneas y los movimientos de cada producto.</p></div><button className="btn secondary small" onClick={() => void loadHistory()} disabled={historyLoading}>{historyLoading ? <Loader2 className="spin" /> : <RotateCcw />}Actualizar</button></div>
        {historyLoading && !historyDocuments.length ? <div className="recent-loading"><Loader2 className="spin" />Cargando historial…</div> : !historyDocuments.length ? <p className="empty-summary">Todavía no hay facturas registradas.</p> : <div className="invoice-history-list">{historyDocuments.map((invoice) => {
          const expanded = openHistoryDocumentId === invoice.id;
          const provider = invoice.provider === "iherb" ? "iHerb" : invoice.provider === "amazon" ? "Amazon" : "Otro proveedor";
          return <article className={`invoice-history-card status-${invoice.status}`} key={invoice.id}>
            <button className="invoice-history-summary" onClick={() => setOpenHistoryDocumentId(expanded ? null : invoice.id)} aria-expanded={expanded}>
              <div><span className="eyebrow">{provider}</span><b>{invoice.orderNumber ? `Compra ${invoice.orderNumber}` : invoice.invoiceNumber ? `Factura ${invoice.invoiceNumber}` : invoice.fileName}</b><small>{invoice.documentDate || new Date(invoice.createdAt).toLocaleDateString("es-CR")} · {invoice.lineCount} línea{invoice.lineCount === 1 ? "" : "s"}</small></div>
              <div className="invoice-history-status"><span className={`status-pill ${invoice.status}`}>{documentStatusLabel(invoice.status)}</span><small>{invoice.ingressedLines} ingresada{invoice.ingressedLines === 1 ? "" : "s"} · {invoice.pendingLines} pendiente{invoice.pendingLines === 1 ? "" : "s"} · {invoice.omittedLines} omitida{invoice.omittedLines === 1 ? "" : "s"}</small><b>{expanded ? "Ocultar detalle" : "Ver factura"}</b></div>
            </button>
            {expanded && <div className="invoice-history-detail">
              {invoice.lines.map((line) => {
                const original = Number(line.originalQuantity ?? line.totalToAdd);
                const active = Number(line.activeQuantity || 0);
                const available = pendingQuantity(line);
                const omitted = line.status === "ignored";
                const state = omitted ? "Omitido / No agregado" : active >= original && original > 0 ? "Ingresado" : active > 0 ? `${active} de ${original} agregadas · ${available} pendientes` : line.hasReversals ? "Revertido · disponible nuevamente" : "Pendiente";
                return <article className={`invoice-history-line status-${line.status}`} key={line.id}>
                  <header><div><b>{line.name}</b><small>{line.barcode || line.secondaryId || "Sin código confirmado"}</small></div><span>{state}</span></header>
                  <div className="history-line-quantities"><span><small>Factura</small><b>{original}</b></span><span><small>Activas</small><b>{active}</b></span><span><small>Disponibles</small><b>{omitted ? 0 : available}</b></span><span><small>Revertidas históricas</small><b>{Number(line.reversedQuantity || 0)}</b></span></div>
                  <details><summary>Ver movimientos ({line.movementHistory?.length || 0})</summary><div className="movement-list">{line.movementHistory?.length ? line.movementHistory.map((movement) => {
                    const operation = history.find((candidate) => candidate.id === movement.operationId);
                    return <div className={movement.quantityChange < 0 ? "reversal" : ""} key={movement.id}><span><b>{movement.quantityChange < 0 ? "Reversa" : "Ingreso"} · {new Date(movement.confirmedAt).toLocaleString("es-CR")}</b><small>{movement.confirmedBy || "Usuario"} · operación {movement.operationId}{movement.reason ? ` · ${movement.reason}` : ""}</small></span><span>{movement.previousQuantity} <b>{movement.quantityChange >= 0 ? "+" : "−"} {Math.abs(movement.quantityChange)}</b> = {movement.resultingQuantity}{movement.quantityChange > 0 && operation && !operation.reversed && <button className="btn danger-outline small" onClick={() => { setReverseTarget(operation); setReverseReason(""); }}><RotateCcw />Revertir ingreso</button>}{movement.quantityChange > 0 && operation?.reversed && <small className="reversed-label">Ingreso revertido</small>}</span></div>;
                  }) : <p className="empty-summary">Esta línea todavía no tiene movimientos.</p>}</div></details>
                </article>;
              })}
            </div>}
          </article>;
        })}</div>}
      </section>}
    </div>

    {removeLineTarget && <div className="nested-modal" role="alertdialog" aria-modal="true"><div className="confirm-card"><div className="delete-symbol"><X /></div><h2>¿Eliminar esta línea manual?</h2><p>Se quitará <b>{removeLineTarget.name || "esta línea"}</b> porque fue agregada manualmente y no pertenece al documento original. Las líneas de la factura y el inventario no cambiarán.</p><div className="confirm-actions"><button className="btn secondary" onClick={() => setRemoveLineTarget(null)} disabled={Boolean(removingLineId)}>No, conservar</button><button className="btn danger-solid" onClick={() => void removeLineFromReview()} disabled={Boolean(removingLineId)}>{removingLineId ? <Loader2 className="spin" /> : <X />}Sí, eliminar línea manual</button></div></div></div>}
    {cancelConfirmOpen && <div className="nested-modal" role="alertdialog" aria-modal="true"><div className="confirm-card"><div className="delete-symbol"><X /></div><h2>¿Eliminar este borrador?</h2><p>Esta acción solo está disponible antes de crear movimientos de inventario. Se borrará el borrador y sus archivos guardados; el inventario no cambiará.</p><div className="confirm-actions"><button className="btn secondary" onClick={() => setCancelConfirmOpen(false)} disabled={canceling}>No, conservar borrador</button><button className="btn danger-solid" onClick={() => void cancelInvoiceReview(false, true)} disabled={canceling}>{canceling ? <Loader2 className="spin" /> : <X />}Sí, eliminar borrador</button></div></div></div>}
    {closeConfirmOpen && <div className="nested-modal" role="alertdialog" aria-modal="true"><div className="confirm-card"><div className="download-symbol"><Save /></div><h2>Hay cambios sin guardar</h2><p>La factura y todo lo ya guardado continuarán en NutriPlus. Si cerrás ahora, únicamente se descartarán las ediciones locales que todavía no guardaste; el inventario no cambiará.</p><div className="confirm-actions"><button className="btn secondary" onClick={() => setCloseConfirmOpen(false)}>Continuar editando</button><button className="btn danger-outline" onClick={closeInvoiceView}>Cerrar sin guardar cambios locales</button></div></div></div>}
    {reanalyzeConfirmOpen && document && <div className="nested-modal" role="alertdialog" aria-modal="true"><div className="confirm-card reanalyze-card"><div className="download-symbol"><Sparkles /></div><span className="eyebrow">Acción administrativa</span><h2>{reanalyzeTarget === "sol" ? "¿Reanalizar con Sol?" : "¿Analizar nuevamente con IA?"}</h2><p>{reanalyzeTarget === "sol" ? <>Se enviará otra vez la factura completa a OpenAI usando <b>gpt-5.6-sol</b>. Esta segunda llamada <b>genera un nuevo consumo</b> y se guardará separada del análisis de Terra.</> : <>Esto enviará otra vez todos los archivos de esta factura a OpenAI usando el modelo principal configurado y <b>generará un nuevo consumo</b>. No se usa el análisis en caché.</>} Los productos ya confirmados y el progreso guardado se conservan.</p>{analysis && <div className="reanalyze-cost"><span>Último análisis</span><b>{costLabel(analysis.estimatedCostUsd)}</b><small>Referencia estimada; el nuevo costo puede variar según páginas y búsquedas.</small></div>}<div className="confirm-actions"><button className="btn secondary" onClick={() => setReanalyzeConfirmOpen(false)} disabled={reanalyzing}>No, conservar análisis</button><button className="btn primary" onClick={() => void reanalyzeInvoice()} disabled={reanalyzing || !aiConfig?.aiAvailable}>{reanalyzing ? <Loader2 className="spin" /> : <Sparkles />}{reanalyzeTarget === "sol" ? "Sí, reanalizar con Sol" : "Sí, generar nuevo consumo"}</button></div></div></div>}
    {pendingBarcode && <div className="nested-modal" role="alertdialog" aria-modal="true"><div className="confirm-card barcode-confirm"><div className="download-symbol"><Barcode /></div><h2>Confirmar código detectado</h2><p>Verificá el número y la presentación antes de guardarlo. No se utilizará hasta que lo confirmés.</p><strong>{pendingBarcode.code}</strong><small>{validateBarcode(pendingBarcode.code).type}</small>{pendingBarcode.sourceUrl && <a className="pending-source-link" href={pendingBarcode.sourceUrl} target="_blank" rel="noreferrer">{pendingBarcode.sourceTitle || pendingBarcode.source}</a>}{pendingBarcode.differences?.map((difference) => <div className="alert warning" key={difference}><AlertCircle />{difference}</div>)}<div className="confirm-actions"><button className="btn secondary" onClick={() => setPendingBarcode(null)}>Cancelar</button><button className="btn primary" onClick={confirmPendingBarcode}><Check />Confirmar código</button></div></div></div>}
    {reverseTarget && <div className="nested-modal" role="dialog" aria-modal="true"><div className="confirm-card reverse-card"><div className="delete-symbol"><RotateCcw /></div><h2>Revertir ingreso</h2><p>Se creará un movimiento contrario sin borrar el historial original. Si ya se vendieron unidades y no hay suficiente inventario, la operación se bloqueará.</p><label className="field"><span>Razón de la reversión</span><textarea value={reverseReason} onChange={(event) => setReverseReason(event.target.value)} placeholder="Ej. cantidad ingresada incorrectamente" /></label><div className="confirm-actions"><button className="btn secondary" onClick={() => setReverseTarget(null)} disabled={reversing}>Cancelar</button><button className="btn danger-solid" onClick={() => void reverseOperation()} disabled={reversing || reverseReason.trim().length < 3}>{reversing ? <Loader2 className="spin" /> : <RotateCcw />}Crear reversión</button></div></div></div>}
    {createProductLine && <div className="nested-modal" role="dialog" aria-modal="true" aria-label="Crear producto desde factura"><div className="confirm-card inline-product-card"><PackagePlus /><h2>Crear producto nuevo</h2><p>Se guardará con las mismas reglas de Productos y quedará seleccionado en esta línea. La factura no se cerrará ni se agregará inventario hasta confirmar el ingreso.</p><label className="field"><span>Nombre</span><input value={newProduct.name} onChange={(event) => setNewProduct({ ...newProduct, name: event.target.value })} required /></label><div className="two"><label className="field"><span>Marca</span><input value={newProduct.brand} onChange={(event) => setNewProduct({ ...newProduct, brand: event.target.value })} /></label><label className="field"><span>Presentación</span><input value={newProduct.presentation} onChange={(event) => setNewProduct({ ...newProduct, presentation: normalizePresentation(event.target.value) || event.target.value })} /></label></div><label className="field"><span>Código de barras</span><div className="code-row"><input inputMode="numeric" value={newProduct.code} onChange={(event) => setNewProduct({ ...newProduct, code: event.target.value })} placeholder="UPC, EAN o GTIN" /><button type="button" className="scan-btn" onClick={() => onRequestScan(`inline:${createProductLine.id}`)}><Camera /><span>Escanear</span></button></div></label><div className="two"><label className="field"><span>Precio de compra USD</span><input type="number" min="0" step=".01" value={newProduct.purchasePriceUsd} onChange={(event) => setNewProduct({ ...newProduct, purchasePriceUsd: event.target.value })} required /></label><label className="field"><span>Peso lb</span><input type="number" min="0" step=".001" value={newProduct.weightLb} onChange={(event) => setNewProduct({ ...newProduct, weightLb: event.target.value })} required /></label></div><label className="check-line"><input type="checkbox" checked={minimumStockEnabled} onChange={(event) => setMinimumStockEnabled(event.target.checked)} /><span><b>Controlar stock mínimo</b><small>Usa la misma alerta y regla de Productos.</small></span></label>{minimumStockEnabled && <label className="field"><span>Stock mínimo</span><input type="number" min="0" step="1" inputMode="numeric" value={minimumStock} onChange={(event) => setMinimumStock(event.target.value)} /></label>}{inlinePricing && <div className="inline-pricing-preview"><span><small>Venta GAM</small><b>{new Intl.NumberFormat("es-CR", { style: "currency", currency: "CRC", maximumFractionDigits: 0 }).format(inlinePricing.gamPriceCrc)}</b></span><span><small>Venta Puerto</small><b>{new Intl.NumberFormat("es-CR", { style: "currency", currency: "CRC", maximumFractionDigits: 0 }).format(inlinePricing.puertoPriceCrc)}</b></span><small>Calculado con los parámetros actuales de NutriPlus.</small></div>}<div className="confirm-actions"><button className="btn secondary" onClick={() => setCreateProductLine(null)} disabled={creatingProduct}>Cancelar</button><button className="btn primary" onClick={() => void saveInlineProduct()} disabled={creatingProduct || !newProduct.name.trim() || !inlinePricing || minimumStockEnabled && (!Number.isInteger(Number(minimumStock)) || Number(minimumStock) < 0)}>{creatingProduct ? <Loader2 className="spin" /> : <Save />}Guardar y seleccionar</button></div></div></div>}
  </div>;
}
