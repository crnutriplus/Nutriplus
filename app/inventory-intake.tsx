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
import type { IntakeLineDto, IntakeLineStatus } from "@/lib/inventory-intake";
import type { NonInventoryRecord, ProductRecord } from "@/lib/pricing";

type Notice = { type: "success" | "error" | "warning"; text: string; sticky?: boolean; dismissOnPageTouch?: boolean; durationMs?: number };

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

export type IntakeScanEvent = { lineId: string; code: string; nonce: number } | null;

type Props = {
  open: boolean;
  products: ProductRecord[];
  quotes: NonInventoryRecord[];
  quickText: string;
  setQuickText: (value: string) => void;
  onQuickSave: () => void;
  onClose: () => void;
  onNotify: (notice: Notice) => void;
  onProductsChanged: (products: ProductRecord[]) => void;
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
  ignored: "Ignorado",
  conflict_identifiers: "Conflicto de identificadores",
  processed: "Procesado",
};

const CONFIRMABLE = new Set<IntakeLineStatus>(["confirmed", "new_product", "non_inventory"]);

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

async function apiJson<T>(response: Response) {
  const raw = await response.text();
  let body: T & { error?: string; errors?: string[] };
  try {
    body = raw ? JSON.parse(raw) as T & { error?: string; errors?: string[] } : {} as T & { error?: string; errors?: string[] };
  } catch {
    throw new Error(response.ok
      ? "El servidor devolvió una respuesta que no se pudo leer. Intentá nuevamente."
      : `El servidor rechazó la operación (código ${response.status}) sin indicar el detalle.`);
  }
  if (!response.ok) {
    const details = body.errors?.length ? ` ${body.errors.join(" ")}` : "";
    throw new Error(`${body.error || "No se pudo completar la operación."}${details}`);
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

function equivalentOwners(code: string, products: ProductRecord[], quotes: NonInventoryRecord[]) {
  const target = validateBarcode(code);
  if (!target.valid || !target.canonical) return { products: [] as ProductRecord[], quotes: [] as NonInventoryRecord[] };
  return {
    products: products.filter((product) => validateBarcode(product.code).canonical === target.canonical),
    quotes: quotes.filter((quote) => validateBarcode(quote.code).canonical === target.canonical),
  };
}

function classifyLine(line: IntakeLineDto, products: ProductRecord[], quotes: NonInventoryRecord[]): IntakeLineDto {
  if (line.action === "ignore" || line.status === "processed") return line;
  const barcode = validateBarcode(line.barcode);
  if (!barcode.valid || !barcode.normalized || !barcode.canonical) {
    return { ...line, barcodeConfirmed: false, status: "requires_confirm_code", action: "pending", canonicalBarcode: "", barcodeType: "", match: null, matchProductId: null, matchNonInventoryId: null };
  }
  const owners = equivalentOwners(barcode.normalized, products, quotes);
  let next: IntakeLineDto = { ...line, barcode: barcode.normalized, canonicalBarcode: barcode.canonical, barcodeType: barcode.type || "" };
  if (owners.products.length + owners.quotes.length > 1) {
    next = { ...next, status: "conflict_identifiers", action: "pending", warnings: [...new Set([...next.warnings, "Este código equivalente aparece en más de un registro."])] };
  } else if (line.matchProductId) {
    const product = products.find((item) => item.id === line.matchProductId);
    const current = validateBarcode(product?.code);
    next = !product || current.valid && current.canonical !== barcode.canonical
      ? { ...next, status: "conflict_identifiers", action: "pending" }
      : { ...next, status: "confirmed", action: "existing", match: { source: "inventory", id: product.id, name: product.name, code: product.code, quantityAvailable: product.quantityAvailable }, matchNonInventoryId: null };
  } else if (line.matchNonInventoryId) {
    const quote = quotes.find((item) => item.id === line.matchNonInventoryId);
    const current = validateBarcode(quote?.code);
    next = !quote || current.valid && current.canonical !== barcode.canonical
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
    open, products, quotes, quickText, setQuickText, onQuickSave, onClose, onNotify,
    onProductsChanged, onRefresh, onRequestScan, scannedBarcode, onConsumeScan, readBarcodeImage,
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
  const [historyLoading, setHistoryLoading] = useState(false);
  const [reverseTarget, setReverseTarget] = useState<IntakeOperation | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const [reversing, setReversing] = useState(false);
  const [pendingVerification, setPendingVerification] = useState<{ operationId: string; documentId: string; lineIds?: string[] } | null>(null);

  const updateLine = useCallback((id: string, changes: Partial<IntakeLineDto>, reclassify = true) => {
    lineRevisionRef.current.set(id, (lineRevisionRef.current.get(id) || 0) + 1);
    setDirtyLineIds((current) => new Set(current).add(id));
    setLines((current) => current.map((line) => {
      if (line.id !== id) return line;
      const next = { ...line, ...changes };
      next.totalToAdd = Math.max(0, (next.receivedQuantity || 0) * Math.max(1, next.unitsPerPackage));
      return reclassify ? classifyLine(next, products, quotes) : next;
    }));
  }, [products, quotes]);

  const updateDocumentMeta = useCallback((changes: Partial<IntakeDocument>) => {
    metaRevisionRef.current += 1;
    setMetaDirty(true);
    setDocument((current) => current ? { ...current, ...changes } : current);
  }, []);

  const resetInvoiceReview = useCallback(() => {
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
    setReanalyzeConfirmOpen(false);
    setSavingLineId(null);
    setConfirmingLineId(null);
    setRemovingLineId(null);
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
    if (!scannedBarcode) return;
    const checked = validateBarcode(scannedBarcode.code);
    if (!checked.valid || !checked.normalized) {
      onNotify({ type: "error", text: checked.error || "El código escaneado no es válido." });
      onConsumeScan();
      return;
    }
    // El escáner llega como un evento externo y debe hidratar la confirmación una sola vez.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingBarcode({ lineId: scannedBarcode.lineId, code: checked.normalized, method: "scanner", source: "Producto físico escaneado" });
    onConsumeScan();
  }, [onConsumeScan, onNotify, scannedBarcode]);

  useEffect(() => {
    if (!open) return;
    try {
      const stored = localStorage.getItem("nutriplus-pending-intake-operation");
      // La comprobación pendiente se conserva fuera de React para sobrevivir una pérdida de conexión.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (stored) setPendingVerification(JSON.parse(stored) as { operationId: string; documentId: string; lineIds?: string[] });
    } catch { /* No hay comprobación pendiente válida. */ }
  }, [open]);

  const selectedLines = useMemo(() => lines.filter((line) => selected.has(line.id) && CONFIRMABLE.has(line.status) && line.action !== "pending" && line.totalToAdd > 0), [lines, selected]);
  const blockedSelected = useMemo(() => lines.filter((line) => selected.has(line.id) && !CONFIRMABLE.has(line.status)), [lines, selected]);
  const hasProcessedLines = useMemo(() => lines.some((line) => Boolean(line.processedOperationId) || line.status === "processed"), [lines]);
  const selectedInvoiceFile = invoiceFiles[selectedFileIndex] || invoiceFiles[0] || null;

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
    if (hasProcessedLines || document.confirmedAt) {
      onNotify({ type: "error", text: "Este ingreso ya tiene movimientos confirmados y no puede borrarse. Podés cerrarlo o revertirlo desde el historial.", sticky: true });
      return false;
    }
    if (pendingVerification) {
      onNotify({ type: "error", text: "Primero comprobá el estado del ingreso pendiente antes de cancelar la factura.", sticky: true });
      return false;
    }
    setCanceling(true);
    try {
      await cancelDraftRequest(document.id);
      resetInvoiceReview();
      setTab("invoice");
      if (showNotice) onNotify({ type: "success", text: "La carga se canceló y el borrador de la factura fue eliminado." });
      if (closeAfter) onClose();
      return true;
    } catch (error) {
      onNotify({ type: "error", text: intakeErrorText(error, "No se pudo cancelar y borrar la factura."), sticky: true });
      return false;
    } finally {
      setCanceling(false);
    }
  }

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const result = await apiJson<{ operations: IntakeOperation[] }>(await fetch("/api/inventory-intake?history=1"));
      setHistory(result.operations);
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
  }

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
    const files = [...(event.currentTarget.files || [])];
    if (!files.length) return;
    if (invoiceMode === "chatgpt_import" && files.length !== 1) {
      onNotify({ type: "error", text: "Seleccioná un único archivo ZIP generado desde ChatGPT.", sticky: true });
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
    resetInvoiceReview();
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
      if (result.exactDuplicate) {
        onNotify({ type: "warning", text: "Esta misma factura ya había sido ingresada. Sus productos procesados permanecen bloqueados para evitar duplicados.", sticky: true });
      } else if (result.cachedAnalysis) {
        onNotify({ type: "success", text: "Se recuperó el análisis y el avance guardados sin volver a generar consumo de OpenAI.", sticky: true });
      } else if (result.manualFallback) {
        onNotify({ type: "error", text: result.aiErrorMessage || "El análisis con IA falló. La factura se conservó y cambió al modo Manual.", sticky: true });
        await runOcrFallback(files, result.document.id, true);
      } else if (invoiceMode === "chatgpt_import") {
        onNotify({
          type: result.reviewRequired ? "warning" : "success",
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
      onNotify({
        type: "error",
        text: intakeErrorText(error, invoiceMode === "chatgpt_import"
          ? "No se pudo importar el paquete de ChatGPT. Revisá el ZIP e intentá nuevamente."
          : "No se pudo guardar o analizar la factura. Revisá el archivo e intentá nuevamente."),
        sticky: true,
      });
    } finally { setReading(false); }
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
      updateLine(line.id, { matchProductId: null, matchNonInventoryId: null, match: null, action: "pending", status: "requires_select_product" }, false);
      return;
    }
    const [source, idValue] = value.split(":");
    const id = Number(idValue);
    if (source === "inventory") updateLine(line.id, { matchProductId: id, matchNonInventoryId: null, action: "existing" });
    else updateLine(line.id, { matchProductId: null, matchNonInventoryId: id, action: "move" });
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

  async function verifyPendingOperation(target = pendingVerification) {
    if (!target) return;
    try {
      const response = await fetch(`/api/inventory-intake/operations/${encodeURIComponent(target.operationId)}`);
      const result = await apiJson<{ operation: { status: string }; products: ProductRecord[]; movements?: Array<{ documentLineId?: string }> }>(response);
      if (result.operation.status === "completed") {
        onProductsChanged(result.products);
        await onRefresh();
        localStorage.removeItem("nutriplus-pending-intake-operation");
        setPendingVerification(null);
        onNotify({ type: "success", text: "El ingreso sí había sido completado y quedó verificado en el historial.", sticky: true });
        const confirmedLineIds = new Set((result.movements || []).map((movement) => movement.documentLineId).filter((value): value is string => Boolean(value)).concat(target.lineIds || []));
        if (document?.id === target.documentId) {
          setLines((current) => current.map((line) => confirmedLineIds.has(line.id) ? { ...line, status: "processed", processedOperationId: target.operationId } : line));
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
      const result = await apiJson<{ operation: { id: string; status: string }; products: ProductRecord[] }>(await fetch(`/api/inventory-intake/${document.id}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mutation-Id": id },
        body: JSON.stringify({ operationId: id, lines: targetLines.map((line) => ({ ...line, selected: true })) }),
      }));
      onProductsChanged(result.products);
      await onRefresh();
      const confirmedIds = new Set(targetLines.map((line) => line.id));
      setLines((current) => current.map((line) => confirmedIds.has(line.id) ? { ...line, status: "processed", processedOperationId: id } : line));
      setSelected((current) => {
        const next = new Set(current);
        confirmedIds.forEach((lineId) => next.delete(lineId));
        return next;
      });
      localStorage.removeItem("nutriplus-pending-intake-operation");
      setPendingVerification(null);
      onNotify({
        type: "success",
        text: `${onlyLineId ? "Producto ingresado" : "Ingreso confirmado"}: ${targetLines.reduce((total, line) => total + line.totalToAdd, 0)} unidades agregadas. Ningún precio fue modificado.`,
        sticky: true,
      });
      void loadHistory();
    } catch (error) {
      if (!confirmationSent) {
        onNotify({ type: "error", text: `${intakeErrorText(error, "No se pudo guardar la revisión.")} El ingreso no se inició y el inventario no cambió.`, sticky: true });
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
            setLines((current) => current.map((line) => confirmedIds.has(line.id) ? { ...line, status: "processed", processedOperationId: id } : line));
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

  async function removeLineFromReview() {
    if (!removeLineTarget) return;
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
      onNotify({ type: "success", text: "El producto se eliminó de esta factura." });
    } catch (error) {
      onNotify({ type: "error", text: intakeErrorText(error, "No se pudo eliminar este producto de la factura."), sticky: true });
    } finally {
      setRemovingLineId(null);
    }
  }

  function closeModal() { onClose(); }

  if (!open) return null;
  return <div className="modal intake-modal" role="dialog" aria-modal="true" aria-label="Agregar inventario">
    <div className="intake-card">
      <header className="modal-head intake-head"><div><span className="eyebrow">Inventario NutriPlus</span><h2>Agregar inventario</h2><p>Las cantidades se suman a la existencia actual. Este proceso nunca cambia precios ni costos.</p></div><button className="icon-btn" onClick={closeModal} aria-label="Cerrar"><X /></button></header>
      <div className="intake-tabs" role="tablist">
        <button className={tab === "invoice" ? "active" : ""} onClick={() => setTab("invoice")}><FileText />Factura</button>
        <button className={tab === "quick" ? "active" : ""} onClick={() => setTab("quick")}><Barcode />Códigos</button>
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}><History />Historial</button>
      </div>

      {pendingVerification && <div className="alert warning intake-verification"><AlertCircle /><span>Hay un ingreso pendiente de comprobación. No lo confirmés de nuevo hasta revisar su estado.</span><button className="btn secondary small" onClick={() => void verifyPendingOperation()}>Comprobar estado</button></div>}

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
                <label className="btn secondary small"><Upload />{document.processingMode === "chatgpt_import" ? "Cambiar paquete" : "Cambiar factura"}<input className="native-file-input" type="file" accept={document.processingMode === "chatgpt_import" ? ".zip,application/zip,application/x-zip-compressed" : "application/pdf,image/*"} multiple={document.processingMode !== "chatgpt_import"} onChange={analyzeFiles} /></label>
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
              const resultingQuantity = currentQuantity + line.totalToAdd;
              const lineCandidates = candidates[line.id] || [];
              const isSelected = selected.has(line.id);
              return <article className={`invoice-line status-${line.status} ${isSelected ? "selected" : "excluded"}`} key={line.id}>
                <div className="invoice-line-top"><label className="product-selector"><input type="checkbox" checked={isSelected} disabled={line.status === "processed"} onChange={() => toggleLineSelection(line)} /><span><Check /></span></label><div><div className="line-statuses"><span className={`status-pill ${line.status}`}>{isSelected ? STATUS_LABELS[line.status] : "No se agregará"}</span>{line.reviewSavedAt && <span className="review-saved-pill"><Save />Progreso guardado</span>}</div><small>Línea {index + 1}{line.pageNumber ? ` · página ${line.pageNumber}` : " · manual"}</small></div><button className="icon-btn danger" onClick={() => setRemoveLineTarget(line)} aria-label="Eliminar producto de la revisión" disabled={line.status === "processed" || removingLineId === line.id}><X /></button></div>
                <div className="invoice-line-grid">
                  <label className="wide"><span>Producto de la factura</span><input value={line.name} onChange={(event) => updateLine(line.id, { name: event.target.value }, false)} /></label>
                  <label><span>Marca</span><input value={line.brand} onChange={(event) => updateLine(line.id, { brand: event.target.value }, false)} /></label>
                  <label><span>Presentación</span><input value={line.presentation} onChange={(event) => updateLine(line.id, { presentation: event.target.value }, false)} /></label>
                  <label><span>Tamaño / contenido</span><input value={line.size} onChange={(event) => updateLine(line.id, { size: event.target.value }, false)} /></label>
                  <label><span>{document.provider === "amazon" ? "ASIN" : document.provider === "iherb" ? "Código iHerb" : "Identificador proveedor"}</span><input value={line.secondaryId} onChange={(event) => updateLine(line.id, { secondaryId: event.target.value, secondaryType: document.provider === "amazon" ? "asin" : document.provider === "iherb" ? "iherb" : "other" }, false)} /></label>
                  <label className="wide"><span>Producto de NutriPlus</span><select value={line.matchProductId ? `inventory:${line.matchProductId}` : line.matchNonInventoryId ? `no_inventory:${line.matchNonInventoryId}` : ""} onChange={(event) => chooseMatch(line, event.target.value)}><option value="">Seleccionar o crear producto nuevo</option><optgroup label="Inventario">{products.map((product) => <option value={`inventory:${product.id}`} key={`p-${product.id}`}>{product.name}{product.code ? ` · ${product.code}` : ""}</option>)}</optgroup><optgroup label="No inventario">{quotes.map((quote) => <option value={`no_inventory:${quote.id}`} key={`q-${quote.id}`}>{quote.name}{quote.code ? ` · ${quote.code}` : ""}</option>)}</optgroup></select></label>
                  <label><span>Cantidad facturada</span><input inputMode="numeric" value={line.billedQuantity ?? ""} onChange={(event) => updateLine(line.id, { billedQuantity: event.target.value === "" ? null : Number(event.target.value) }, false)} /></label>
                  <label><span>Cantidad recibida</span><input inputMode="numeric" value={line.receivedQuantity ?? ""} onChange={(event) => updateLine(line.id, { receivedQuantity: event.target.value === "" ? null : Math.max(0, Number(event.target.value) || 0) })} /></label>
                  <label><span>Unidades por paquete</span><input inputMode="numeric" value={line.unitsPerPackage} onChange={(event) => updateLine(line.id, { unitsPerPackage: Math.max(1, Number(event.target.value) || 1), barcodeLevel: Number(event.target.value) > 1 ? line.barcodeLevel : "unit" })} /></label>
                  {line.unitsPerPackage > 1 && <label><span>Nivel del código</span><select value={line.barcodeLevel} onChange={(event) => updateLine(line.id, { barcodeLevel: event.target.value as IntakeLineDto["barcodeLevel"] })}><option value="">Confirmar nivel</option><option value="unit">Unidad individual</option><option value="package">Paquete completo</option><option value="distribution">Caja de distribución</option><option value="set">Set de productos</option></select></label>}
                  <label className="wide barcode-field"><span>UPC / EAN / GTIN</span><div><input value={line.barcode} inputMode="numeric" onChange={(event) => updateLine(line.id, { barcode: event.target.value, barcodeConfirmed: false })} placeholder="Código pendiente" /><button className={`btn small ${line.barcodeConfirmed ? "primary" : "danger-outline"}`} onClick={() => toggleBarcodeConfirmation(line)}><Check />{line.barcodeConfirmed ? "Código confirmado" : "Confirmar código de barras"}</button></div></label>
                </div>
                {(!line.barcodeConfirmed || ["requires_confirm_code", "conflict_identifiers"].includes(line.status)) && <div className="code-pending-box"><p><b>El código de barras está pendiente de confirmación.</b> Seleccioná una opción para continuar.</p><div><button className="btn secondary small" onClick={() => onRequestScan(line.id)}><Camera />Escanear código</button><label className="btn secondary small"><ImageUp />Subir imagen<input className="native-file-input" type="file" accept="image/*" onChange={(event) => { const input = event.currentTarget; const file = input.files?.[0]; if (file) void readLineImage(line.id, file).finally(() => { input.value = ""; }); }} /></label><button className="btn secondary small" onClick={() => void pasteLineCode(line.id)}><ClipboardPaste />Pegar código</button><button className="btn secondary small" onClick={() => setManualCodeLine(manualCodeLine === line.id ? null : line.id)}><Barcode />Escribir código</button><button className="btn ghost small" onClick={() => void lookupCode(line)} disabled={lookupLineId === line.id}>{lookupLineId === line.id ? <Loader2 className="spin" /> : <Search />}Buscar código</button></div>{manualCodeLine === line.id && <div className="manual-code-row"><input value={line.barcode} inputMode="numeric" onChange={(event) => updateLine(line.id, { barcode: event.target.value, barcodeConfirmed: false })} placeholder="Escribí 8, 12, 13 o 14 dígitos" /><button className="btn primary small" onClick={() => toggleBarcodeConfirmation(line)}>Revisar</button></div>}</div>}
                {lookupMessages[line.id] && <div className={`lookup-results ${lineCandidates.length ? "has-results" : ""}`}><p>{lookupMessages[line.id]}</p>{lineCandidates.map((candidate) => <button key={`${candidate.code}-${candidate.source}`} onClick={() => setPendingBarcode({ lineId: line.id, code: candidate.code, method: "external_source", source: candidate.source, sourceUrl: candidate.sourceUrl, sourceTitle: candidate.title, differences: candidate.differences })}><span><b>{candidate.code} · {candidate.type}</b><small>{candidate.title}{candidate.presentation ? ` · ${candidate.presentation}` : ""}</small>{candidate.differences.map((difference) => <em key={difference}>{difference}</em>)}</span><strong>{candidate.confidence}%<small>Confirmar</small></strong></button>)}</div>}
                {(line.barcodeSource || line.barcodeSourceUrl) && <div className={`barcode-source-card ${line.barcodeDifferences.length ? "warning" : ""}`}><FileSearch /><div><small>Fuente del código de barras</small>{line.barcodeSourceUrl ? <a href={line.barcodeSourceUrl} target="_blank" rel="noreferrer">{line.barcodeSourceTitle || line.barcodeSource || "Abrir fuente consultada"}</a> : <b>{line.barcodeSourceTitle || line.barcodeSource}</b>}{line.barcodeDifferences.map((difference) => <em key={difference}>{difference}</em>)}</div><span>{line.barcodeLookupStatus === "found_exact" ? "Coincidencia exacta" : line.barcodeLookupStatus === "suggestion" ? "Revisar diferencias" : "Pendiente"}</span></div>}
                {evidenceEntries(line.fieldEvidence).length > 0 && <div className="evidence-strip line-evidence"><span><FileSearch />Evidencia de extracción</span><div>{evidenceEntries(line.fieldEvidence).map(([field, item]) => <small key={field}><b>{EVIDENCE_LABELS[field] || field}</b>{item.page ? `p. ${item.page}` : "sin página"} · {item.confidence ?? 0}%</small>)}</div></div>}
                {line.warnings.map((warning) => <div className="alert warning line-warning" key={warning}><AlertCircle />{warning}</div>)}
                <div className="quantity-preview"><span><small>Existencia actual</small><b>{line.match?.source === "inventory" ? currentQuantity : line.action === "move" || line.action === "create" ? 0 : "—"}</b></span><span><small>Se agregará</small><b>+{line.totalToAdd}</b></span><span><small>Existencia resultante</small><b>{line.match?.source === "inventory" || ["move", "create"].includes(line.action) ? resultingQuantity : "—"}</b></span></div>
                {line.status === "non_inventory" && <div className="alert success"><PackagePlus />Al confirmar: Mover a inventario y agregar cantidad. Sus precios y demás datos permanecerán sin cambios.</div>}
                {line.status !== "processed" && <div className="line-save-actions">
                  <div>{line.status === "new_product" && <p><b>Producto nuevo:</b> se creará en Inventario sin precios únicamente cuando confirmés el ingreso.</p>}{line.reviewSavedAt && !dirtyLineIds.has(line.id) && <small>Si cerrás la página, este avance se recuperará al volver a subir la factura.</small>}</div>
                  <div className="line-action-buttons">
                    <button className={`btn small ${line.reviewSavedAt && !dirtyLineIds.has(line.id) ? "success-static" : "secondary"}`} onClick={() => void saveOneLine(line.id)} disabled={!isSelected || savingDraft || confirming || line.reviewSavedAt !== "" && !dirtyLineIds.has(line.id)}>{savingLineId === line.id ? <Loader2 className="spin" /> : line.reviewSavedAt && !dirtyLineIds.has(line.id) ? <Check /> : <Save />}{line.reviewSavedAt && !dirtyLineIds.has(line.id) ? "Producto guardado" : line.reviewSavedAt ? "Guardar cambios" : "Guardar producto"}</button>
                    <button className="btn primary small" onClick={() => void confirmIngreso(line.id)} disabled={!isSelected || confirming || savingDraft || !CONFIRMABLE.has(line.status) || line.action === "pending" || line.totalToAdd <= 0 || Boolean(pendingVerification)}>{confirmingLineId === line.id ? <Loader2 className="spin" /> : <ShieldCheck />}{confirmingLineId === line.id ? "Ingresando…" : `Ingresar este producto (+${line.totalToAdd})`}</button>
                  </div>
                </div>}
              </article>;
            })}
          </div>
          <p className="split-help">Para distribuir un set entre productos diferentes, agregá una línea por componente y eliminá la línea original con la X.</p>
          {blockedSelected.length > 0 && <div className="alert error"><AlertCircle />{blockedSelected.length} línea{blockedSelected.length === 1 ? " seleccionada necesita" : "s seleccionadas necesitan"} revisión antes de confirmar.</div>}
          <div className="intake-footer"><button className="btn danger-outline" onClick={() => setCancelConfirmOpen(true)} disabled={canceling || confirming || Boolean(pendingVerification)}><X />Cancelar todo</button><button className="btn secondary" onClick={() => void saveDraft({ reviewedLineIds: new Set(lines.filter((line) => selected.has(line.id) && line.status !== "processed").map((line) => line.id)) })} disabled={savingDraft || confirming}>{savingDraft && !savingLineId ? <Loader2 className="spin" /> : <Save />}Guardar toda la revisión</button><button className="btn primary" onClick={() => void confirmIngreso()} disabled={confirming || savingDraft || !selectedLines.length || blockedSelected.length > 0 || Boolean(pendingVerification)}>{confirming ? <Loader2 className="spin" /> : <ShieldCheck />}Confirmar ingreso ({selectedLines.reduce((total, line) => total + line.totalToAdd, 0)} unidades)</button></div>
        </>}
      </section>}

      {tab === "history" && <section className="intake-pane intake-history">
        <div className="intake-intro"><FileClock /><div><h3>Historial de movimientos</h3><p>Cada ingreso conserva la existencia anterior, la cantidad agregada y la existencia resultante.</p></div><button className="btn secondary small" onClick={() => void loadHistory()} disabled={historyLoading}>{historyLoading ? <Loader2 className="spin" /> : <RotateCcw />}Actualizar</button></div>
        {historyLoading && !history.length ? <div className="recent-loading"><Loader2 className="spin" />Cargando historial…</div> : !history.length ? <p className="empty-summary">Todavía no hay ingresos registrados.</p> : <div className="operation-list">{history.map((operation) => <article className={operation.operationType === "reversal" ? "reversal" : ""} key={operation.id}><header><div><b>{operation.operationType === "reversal" ? "Reversión" : operation.fileName}</b><small>{new Date(operation.confirmedAt).toLocaleString("es-CR")} · {operation.confirmedBy || "Usuario"}</small></div><span>{operation.totalUnits > 0 ? "+" : ""}{operation.totalUnits} unidades</span></header>{(operation.orderNumber || operation.shipmentNumber) && <p>{operation.orderNumber ? `Pedido ${operation.orderNumber}` : "Pedido sin número"}{operation.shipmentNumber ? ` · rastreo ${operation.shipmentNumber}` : ""}</p>}<div className="movement-list">{operation.movements.map((movement) => <div key={movement.id}><span><b>{movement.productName}</b><small>{movement.barcode || "Sin código"}</small></span><span>{movement.previousQuantity} <b>{movement.quantityChange >= 0 ? "+" : "−"} {Math.abs(movement.quantityChange)}</b> = {movement.resultingQuantity}</span></div>)}</div>{operation.operationType !== "reversal" && !operation.reversed && <button className="btn danger-outline small" onClick={() => { setReverseTarget(operation); setReverseReason(""); }}><RotateCcw />Revertir ingreso</button>}{operation.reversed && <small className="reversed-label">Este ingreso ya fue revertido mediante un movimiento contrario.</small>}</article>)}</div>}
      </section>}
    </div>

    {removeLineTarget && <div className="nested-modal" role="alertdialog" aria-modal="true"><div className="confirm-card"><div className="delete-symbol"><X /></div><h2>¿Eliminar este producto?</h2><p>Se quitará <b>{removeLineTarget.name || "este producto"}</b> de la revisión. Ya no aparecerá en esta factura ni será necesario completar sus datos.</p><div className="confirm-actions"><button className="btn secondary" onClick={() => setRemoveLineTarget(null)} disabled={Boolean(removingLineId)}>No, conservar</button><button className="btn danger-solid" onClick={() => void removeLineFromReview()} disabled={Boolean(removingLineId)}>{removingLineId ? <Loader2 className="spin" /> : <X />}Sí, eliminar</button></div></div></div>}
    {cancelConfirmOpen && <div className="nested-modal" role="alertdialog" aria-modal="true"><div className="confirm-card"><div className="delete-symbol"><X /></div><h2>¿Cancelar toda la carga?</h2><p>Se borrará el borrador completo, incluido el progreso guardado producto por producto. No quedará registrado como ingresado y volverás a la pantalla para cargar otra factura.</p><div className="confirm-actions"><button className="btn secondary" onClick={() => setCancelConfirmOpen(false)} disabled={canceling}>No, continuar</button><button className="btn danger-solid" onClick={() => void cancelInvoiceReview(false, true)} disabled={canceling}>{canceling ? <Loader2 className="spin" /> : <X />}Sí, cancelar y borrar</button></div></div></div>}
    {reanalyzeConfirmOpen && document && <div className="nested-modal" role="alertdialog" aria-modal="true"><div className="confirm-card reanalyze-card"><div className="download-symbol"><Sparkles /></div><span className="eyebrow">Acción administrativa</span><h2>{reanalyzeTarget === "sol" ? "¿Reanalizar con Sol?" : "¿Analizar nuevamente con IA?"}</h2><p>{reanalyzeTarget === "sol" ? <>Se enviará otra vez la factura completa a OpenAI usando <b>gpt-5.6-sol</b>. Esta segunda llamada <b>genera un nuevo consumo</b> y se guardará separada del análisis de Terra.</> : <>Esto enviará otra vez todos los archivos de esta factura a OpenAI usando el modelo principal configurado y <b>generará un nuevo consumo</b>. No se usa el análisis en caché.</>} Los productos ya confirmados y el progreso guardado se conservan.</p>{analysis && <div className="reanalyze-cost"><span>Último análisis</span><b>{costLabel(analysis.estimatedCostUsd)}</b><small>Referencia estimada; el nuevo costo puede variar según páginas y búsquedas.</small></div>}<div className="confirm-actions"><button className="btn secondary" onClick={() => setReanalyzeConfirmOpen(false)} disabled={reanalyzing}>No, conservar análisis</button><button className="btn primary" onClick={() => void reanalyzeInvoice()} disabled={reanalyzing || !aiConfig?.aiAvailable}>{reanalyzing ? <Loader2 className="spin" /> : <Sparkles />}{reanalyzeTarget === "sol" ? "Sí, reanalizar con Sol" : "Sí, generar nuevo consumo"}</button></div></div></div>}
    {pendingBarcode && <div className="nested-modal" role="alertdialog" aria-modal="true"><div className="confirm-card barcode-confirm"><div className="download-symbol"><Barcode /></div><h2>Confirmar código detectado</h2><p>Verificá el número y la presentación antes de guardarlo. No se utilizará hasta que lo confirmés.</p><strong>{pendingBarcode.code}</strong><small>{validateBarcode(pendingBarcode.code).type}</small>{pendingBarcode.sourceUrl && <a className="pending-source-link" href={pendingBarcode.sourceUrl} target="_blank" rel="noreferrer">{pendingBarcode.sourceTitle || pendingBarcode.source}</a>}{pendingBarcode.differences?.map((difference) => <div className="alert warning" key={difference}><AlertCircle />{difference}</div>)}<div className="confirm-actions"><button className="btn secondary" onClick={() => setPendingBarcode(null)}>Cancelar</button><button className="btn primary" onClick={confirmPendingBarcode}><Check />Confirmar código</button></div></div></div>}
    {reverseTarget && <div className="nested-modal" role="dialog" aria-modal="true"><div className="confirm-card reverse-card"><div className="delete-symbol"><RotateCcw /></div><h2>Revertir ingreso</h2><p>Se creará un movimiento contrario sin borrar el historial original. Si ya se vendieron unidades y no hay suficiente inventario, la operación se bloqueará.</p><label className="field"><span>Razón de la reversión</span><textarea value={reverseReason} onChange={(event) => setReverseReason(event.target.value)} placeholder="Ej. cantidad ingresada incorrectamente" /></label><div className="confirm-actions"><button className="btn secondary" onClick={() => setReverseTarget(null)} disabled={reversing}>Cancelar</button><button className="btn danger-solid" onClick={() => void reverseOperation()} disabled={reversing || reverseReason.trim().length < 3}>{reversing ? <Loader2 className="spin" /> : <RotateCcw />}Crear reversión</button></div></div></div>}
  </div>;
}
