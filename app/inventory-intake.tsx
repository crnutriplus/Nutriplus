"use client";

import {
  AlertCircle,
  Barcode,
  Camera,
  Check,
  ClipboardPaste,
  FileClock,
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
  status: string;
  warnings: string[];
  duplicateOf: string;
  createdAt: string;
  confirmedAt: string;
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

async function apiJson<T>(response: Response) {
  const body = await response.json() as T & { error?: string; errors?: string[] };
  if (!response.ok) {
    const details = body.errors?.length ? ` ${body.errors.join(" ")}` : "";
    throw new Error(`${body.error || "No se pudo completar la operación."}${details}`);
  }
  return body;
}

function operationId(prefix: string) {
  return `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
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
    return { ...line, status: "requires_confirm_code", action: "pending", canonicalBarcode: "", barcodeType: "", match: null, matchProductId: null, matchNonInventoryId: null };
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
    confidence: 100,
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
  const [lines, setLines] = useState<IntakeLineDto[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reading, setReading] = useState(false);
  const [readProgress, setReadProgress] = useState({ current: 0, total: 1, message: "" });
  const [confirming, setConfirming] = useState(false);
  const confirmingRef = useRef(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [lookupLineId, setLookupLineId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Record<string, CodeCandidate[]>>({});
  const [lookupMessages, setLookupMessages] = useState<Record<string, string>>({});
  const [pendingBarcode, setPendingBarcode] = useState<{ lineId: string; code: string; method: string; source: string } | null>(null);
  const [manualCodeLine, setManualCodeLine] = useState<string | null>(null);
  const [history, setHistory] = useState<IntakeOperation[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [reverseTarget, setReverseTarget] = useState<IntakeOperation | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const [reversing, setReversing] = useState(false);
  const [pendingVerification, setPendingVerification] = useState<{ operationId: string; documentId: string } | null>(null);

  const updateLine = useCallback((id: string, changes: Partial<IntakeLineDto>, reclassify = true) => {
    setLines((current) => current.map((line) => {
      if (line.id !== id) return line;
      const next = { ...line, ...changes };
      next.totalToAdd = Math.max(0, (next.receivedQuantity || 0) * Math.max(1, next.unitsPerPackage));
      return reclassify ? classifyLine(next, products, quotes) : next;
    }));
  }, [products, quotes]);

  useEffect(() => {
    if (!scannedBarcode) return;
    const checked = validateBarcode(scannedBarcode.code);
    if (!checked.valid || !checked.normalized) {
      onNotify({ type: "error", text: checked.error || "El código escaneado no es válido." });
      onConsumeScan();
      return;
    }
    setPendingBarcode({ lineId: scannedBarcode.lineId, code: checked.normalized, method: "scanner", source: "Producto físico escaneado" });
    onConsumeScan();
  }, [onConsumeScan, onNotify, scannedBarcode]);

  useEffect(() => {
    if (!open) return;
    try {
      const stored = localStorage.getItem("nutriplus-pending-intake-operation");
      if (stored) setPendingVerification(JSON.parse(stored) as { operationId: string; documentId: string });
    } catch { /* No hay comprobación pendiente válida. */ }
  }, [open]);

  const selectedLines = useMemo(() => lines.filter((line) => selected.has(line.id) && CONFIRMABLE.has(line.status) && line.action !== "pending" && line.totalToAdd > 0), [lines, selected]);
  const blockedSelected = useMemo(() => lines.filter((line) => selected.has(line.id) && !CONFIRMABLE.has(line.status)), [lines, selected]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const result = await apiJson<{ operations: IntakeOperation[] }>(await fetch("/api/inventory-intake?history=1"));
      setHistory(result.operations);
    } catch (error) {
      onNotify({ type: "error", text: error instanceof Error ? error.message : "No se pudo cargar el historial." });
    } finally { setHistoryLoading(false); }
  }, [onNotify]);

  useEffect(() => { if (open && tab === "history") void loadHistory(); }, [loadHistory, open, tab]);

  async function analyzeFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files || [])];
    event.target.value = "";
    if (!files.length) return;
    setReading(true);
    setDocument(null);
    setLines([]);
    setSelected(new Set());
    try {
      const { readInvoiceFiles } = await import("@/lib/invoice-reader");
      const read = await readInvoiceFiles(files, (progress) => setReadProgress({ current: progress.current, total: Math.max(1, progress.total), message: progress.message }));
      const result = await apiJson<{ document: IntakeDocument; lines: IntakeLineDto[]; duplicate: boolean; exactDuplicate: boolean }>(await fetch("/api/inventory-intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fingerprint: read.fingerprint, fileName: read.fileName, mimeTypes: read.mimeTypes, pages: read.pages, warnings: read.warnings }),
      }));
      const hydrated = result.lines.map((line) => classifyLine(line, products, quotes));
      setDocument(result.document);
      setLines(hydrated);
      setSelected(new Set(hydrated.filter((line) => CONFIRMABLE.has(line.status) && line.totalToAdd > 0).map((line) => line.id)));
      if (result.exactDuplicate) onNotify({ type: "warning", text: "Esta misma factura ya había sido cargada. Las líneas procesadas no se volverán a sumar.", sticky: true });
      else onNotify({ type: "success", text: `Factura leída: ${hydrated.length} producto${hydrated.length === 1 ? "" : "s"} para revisar.` });
    } catch (error) {
      onNotify({ type: "error", text: error instanceof Error ? error.message : "No se pudo leer la factura.", sticky: true });
    } finally { setReading(false); }
  }

  async function saveDraft(showNotice = true) {
    if (!document || savingDraft) return;
    setSavingDraft(true);
    try {
      await apiJson(await fetch(`/api/inventory-intake/${document.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...document, lines }),
      }));
      if (showNotice) onNotify({ type: "success", text: "La revisión quedó guardada sin modificar el inventario." });
    } catch (error) {
      if (showNotice) onNotify({ type: "error", text: error instanceof Error ? error.message : "No se pudo guardar la revisión." });
    } finally { setSavingDraft(false); }
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
      setLookupMessages((current) => ({ ...current, [line.id]: error instanceof Error ? error.message : "No se pudo buscar el código." }));
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
      warnings: [],
    });
    setPendingBarcode(null);
    setManualCodeLine(null);
    onNotify({ type: "success", text: `Código ${checked.normalized} confirmado para la vista previa.` });
  }

  async function readLineImage(lineId: string, file: File) {
    try {
      const code = await readBarcodeImage(file);
      const checked = validateBarcode(code);
      if (!checked.valid || !checked.normalized) throw new Error(checked.error || "La imagen no contiene un código válido.");
      setPendingBarcode({ lineId, code: checked.normalized, method: "barcode_image", source: "Imagen del código físico" });
    } catch (error) {
      onNotify({ type: "error", text: error instanceof Error ? error.message : "No se encontró un código de barras en la imagen." });
    }
  }

  async function pasteLineCode(lineId: string) {
    try {
      const value = (await navigator.clipboard.readText()).trim();
      const checked = validateBarcode(value);
      if (!checked.valid || !checked.normalized) throw new Error(checked.error || "El portapapeles no contiene un código válido.");
      setPendingBarcode({ lineId, code: checked.normalized, method: "clipboard", source: "Código pegado y confirmado" });
    } catch (error) {
      onNotify({ type: "warning", text: error instanceof Error ? error.message : "No se pudo leer el portapapeles." });
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

  async function verifyPendingOperation(target = pendingVerification) {
    if (!target) return;
    try {
      const response = await fetch(`/api/inventory-intake/operations/${encodeURIComponent(target.operationId)}`);
      const result = await apiJson<{ operation: { status: string }; products: ProductRecord[] }>(response);
      if (result.operation.status === "completed") {
        onProductsChanged(result.products);
        await onRefresh();
        localStorage.removeItem("nutriplus-pending-intake-operation");
        setPendingVerification(null);
        onNotify({ type: "success", text: "El ingreso sí había sido completado y quedó verificado en el historial.", sticky: true });
        if (document?.id === target.documentId) setLines((current) => current.map((line) => selected.has(line.id) ? { ...line, status: "processed", processedOperationId: target.operationId } : line));
      }
    } catch (error) {
      onNotify({ type: "warning", text: error instanceof Error ? `El ingreso continúa pendiente de comprobación: ${error.message}` : "El ingreso continúa pendiente de comprobación.", sticky: true });
    }
  }

  async function confirmIngreso() {
    if (!document || confirmingRef.current || !selectedLines.length || blockedSelected.length) return;
    confirmingRef.current = true;
    setConfirming(true);
    const id = operationId("ingress");
    const pending = { operationId: id, documentId: document.id };
    localStorage.setItem("nutriplus-pending-intake-operation", JSON.stringify(pending));
    setPendingVerification(pending);
    try {
      await saveDraft(false);
      const result = await apiJson<{ operation: { id: string; status: string }; products: ProductRecord[] }>(await fetch(`/api/inventory-intake/${document.id}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mutation-Id": id },
        body: JSON.stringify({ operationId: id, lines: selectedLines.map((line) => ({ ...line, selected: true })) }),
      }));
      onProductsChanged(result.products);
      await onRefresh();
      setLines((current) => current.map((line) => selected.has(line.id) ? { ...line, status: "processed", processedOperationId: id } : line));
      setSelected(new Set());
      localStorage.removeItem("nutriplus-pending-intake-operation");
      setPendingVerification(null);
      onNotify({ type: "success", text: `Ingreso confirmado: ${selectedLines.reduce((total, line) => total + line.totalToAdd, 0)} unidades agregadas. Ningún precio fue modificado.`, sticky: true });
      void loadHistory();
    } catch (error) {
      try {
        const response = await fetch(`/api/inventory-intake/operations/${encodeURIComponent(id)}`);
        if (response.ok) {
          const checked = await apiJson<{ operation: { status: string }; products: ProductRecord[] }>(response);
          if (checked.operation.status === "completed") {
            onProductsChanged(checked.products);
            await onRefresh();
            localStorage.removeItem("nutriplus-pending-intake-operation");
            setPendingVerification(null);
            onNotify({ type: "success", text: "El ingreso fue completado y verificado después del problema de conexión.", sticky: true });
            return;
          }
        }
      } catch { /* La operación queda pendiente de comprobación manual. */ }
      onNotify({ type: "error", text: `${error instanceof Error ? error.message : "No se pudo confirmar el ingreso."} No lo repitás: usá “Comprobar estado” para verificar si se registró.`, sticky: true });
    } finally {
      confirmingRef.current = false;
      setConfirming(false);
    }
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
      onNotify({ type: "error", text: error instanceof Error ? error.message : "No se pudo revertir el ingreso.", sticky: true });
    } finally { setReversing(false); }
  }

  function closeModal() {
    if (document && lines.some((line) => !line.processedOperationId)) void saveDraft(false);
    onClose();
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

      {pendingVerification && <div className="alert warning intake-verification"><AlertCircle /><span>Hay un ingreso pendiente de comprobación. No lo confirmés de nuevo hasta revisar su estado.</span><button className="btn secondary small" onClick={() => void verifyPendingOperation()}>Comprobar estado</button></div>}

      {tab === "quick" && <section className="intake-pane quick-intake">
        <div className="intake-intro"><PackagePlus /><div><h3>Ingreso rápido por código</h3><p>Usá una línea por producto. La cantidad ingresada se <b>suma</b>; no reemplaza la existencia.</p></div></div>
        <div className="quick-example"><code>NP-001: 2</code><span>Si hay 10 disponibles, quedarán 12.</span></div>
        <textarea className="quantity-input" value={quickText} onChange={(event) => setQuickText(event.target.value)} placeholder={"NP-001: 2\n7501234567890: 5"} autoFocus />
        <div className="alert success"><ShieldCheck /><span>La suma utiliza la existencia más reciente y un identificador único para evitar duplicados al reintentar.</span></div>
        <div className="confirm-actions"><button className="btn secondary" onClick={closeModal}>Cancelar</button><button className="btn primary" onClick={onQuickSave} disabled={!quickText.trim()}><PackagePlus />Agregar cantidades</button></div>
      </section>}

      {tab === "invoice" && <section className="intake-pane invoice-intake">
        {!document && !reading && <label className="surface invoice-upload"><span className="upload-icon"><Upload /></span><h3>Subir factura</h3><p>PDF, fotografías, capturas y documentos de varias páginas.</p><span className="btn primary"><FileText />Elegir archivos</span><input className="native-file-input" type="file" accept="application/pdf,image/*" multiple onChange={analyzeFiles} /></label>}
        {reading && <div className="surface invoice-reading"><Loader2 className="spin" /><h3>Leyendo la factura</h3><p>{readProgress.message}</p><div className="progress"><span style={{ width: `${Math.round(readProgress.current / Math.max(1, readProgress.total) * 100)}%` }} /></div><b>{Math.round(readProgress.current / Math.max(1, readProgress.total) * 100)}%</b></div>}
        {document && !reading && <>
          <div className="surface invoice-summary">
            <div className="invoice-summary-head"><div><span className="eyebrow">Vista previa obligatoria</span><h3>{document.fileName}</h3><p>{document.pageCount} página{document.pageCount === 1 ? "" : "s"} · {lines.length} línea{lines.length === 1 ? "" : "s"}</p></div><label className="btn secondary small"><Upload />Cambiar factura<input className="native-file-input" type="file" accept="application/pdf,image/*" multiple onChange={analyzeFiles} /></label></div>
            <div className="invoice-meta-grid">
              <label><span>Proveedor</span><select value={document.provider} onChange={(event) => setDocument({ ...document, provider: event.target.value as IntakeDocument["provider"] })}><option value="amazon">Amazon</option><option value="iherb">iHerb</option><option value="other">Otra tienda</option></select></label>
              <label><span>N.º pedido</span><input value={document.orderNumber} onChange={(event) => setDocument({ ...document, orderNumber: event.target.value })} /></label>
              <label><span>N.º factura</span><input value={document.invoiceNumber} onChange={(event) => setDocument({ ...document, invoiceNumber: event.target.value })} /></label>
              <label><span>N.º envío</span><input value={document.shipmentNumber} onChange={(event) => setDocument({ ...document, shipmentNumber: event.target.value })} /></label>
              <label><span>Fecha</span><input value={document.documentDate} onChange={(event) => setDocument({ ...document, documentDate: event.target.value })} /></label>
            </div>
            <div className="alert success"><ShieldCheck /><span>Los precios, costos, peso, courier, entrega, Correos, ganancias y tipo de cambio están excluidos de esta pantalla y de la actualización.</span></div>
            {document.warnings.map((warning) => <div className="alert warning" key={warning}><AlertCircle />{warning}</div>)}
          </div>

          <div className="invoice-lines-head"><div><h3>Productos reconocidos</h3><p>Confirmá código, producto, presentación y cantidad físicamente recibida.</p></div><button className="btn secondary small" onClick={() => { const line = emptyManualLine(); setLines((current) => [...current, line]); setSelected((current) => new Set(current).add(line.id)); }}><Plus />Agregar línea</button></div>
          <div className="invoice-preview-table" role="table" aria-label="Vista previa del ingreso de inventario">
            {lines.map((line, index) => {
              const currentQuantity = line.match?.quantityAvailable ?? 0;
              const resultingQuantity = currentQuantity + line.totalToAdd;
              const lineCandidates = candidates[line.id] || [];
              const isSelected = selected.has(line.id);
              return <article className={`invoice-line status-${line.status} ${isSelected ? "selected" : ""}`} key={line.id}>
                <div className="invoice-line-top"><label className="product-selector"><input type="checkbox" checked={isSelected} disabled={line.status === "processed" || line.action === "ignore"} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(line.id)) next.delete(line.id); else next.add(line.id); return next; })} /><span><Check /></span></label><div><span className={`status-pill ${line.status}`}>{STATUS_LABELS[line.status]}</span><small>Línea {index + 1}{line.pageNumber ? ` · página ${line.pageNumber}` : " · manual"}</small></div><button className="icon-btn" onClick={() => updateLine(line.id, { action: "ignore", status: "ignored" }, false)} aria-label="Ignorar línea"><X /></button></div>
                <div className="invoice-line-grid">
                  <label className="wide"><span>Producto de la factura</span><input value={line.name} onChange={(event) => updateLine(line.id, { name: event.target.value }, false)} /></label>
                  <label><span>Marca</span><input value={line.brand} onChange={(event) => updateLine(line.id, { brand: event.target.value }, false)} /></label>
                  <label><span>Presentación</span><input value={line.presentation} onChange={(event) => updateLine(line.id, { presentation: event.target.value }, false)} /></label>
                  <label><span>{document.provider === "amazon" ? "ASIN" : document.provider === "iherb" ? "Código iHerb" : "Identificador proveedor"}</span><input value={line.secondaryId} onChange={(event) => updateLine(line.id, { secondaryId: event.target.value, secondaryType: document.provider === "amazon" ? "asin" : document.provider === "iherb" ? "iherb" : "other" }, false)} /></label>
                  <label className="wide"><span>Producto de NutriPlus</span><select value={line.matchProductId ? `inventory:${line.matchProductId}` : line.matchNonInventoryId ? `no_inventory:${line.matchNonInventoryId}` : ""} onChange={(event) => chooseMatch(line, event.target.value)}><option value="">Seleccionar o crear producto nuevo</option><optgroup label="Inventario">{products.map((product) => <option value={`inventory:${product.id}`} key={`p-${product.id}`}>{product.name}{product.code ? ` · ${product.code}` : ""}</option>)}</optgroup><optgroup label="No inventario">{quotes.map((quote) => <option value={`no_inventory:${quote.id}`} key={`q-${quote.id}`}>{quote.name}{quote.code ? ` · ${quote.code}` : ""}</option>)}</optgroup></select></label>
                  <label><span>Cantidad facturada</span><input inputMode="numeric" value={line.billedQuantity ?? ""} onChange={(event) => updateLine(line.id, { billedQuantity: event.target.value === "" ? null : Number(event.target.value) }, false)} /></label>
                  <label><span>Cantidad recibida</span><input inputMode="numeric" value={line.receivedQuantity ?? ""} onChange={(event) => updateLine(line.id, { receivedQuantity: event.target.value === "" ? null : Math.max(0, Number(event.target.value) || 0) })} /></label>
                  <label><span>Unidades por paquete</span><input inputMode="numeric" value={line.unitsPerPackage} onChange={(event) => updateLine(line.id, { unitsPerPackage: Math.max(1, Number(event.target.value) || 1), barcodeLevel: Number(event.target.value) > 1 ? line.barcodeLevel : "unit" })} /></label>
                  {line.unitsPerPackage > 1 && <label><span>Nivel del código</span><select value={line.barcodeLevel} onChange={(event) => updateLine(line.id, { barcodeLevel: event.target.value as IntakeLineDto["barcodeLevel"] })}><option value="">Confirmar nivel</option><option value="unit">Unidad individual</option><option value="package">Paquete completo</option><option value="distribution">Caja de distribución</option><option value="set">Set de productos</option></select></label>}
                  <label className="wide barcode-field"><span>UPC / EAN / GTIN</span><div><input value={line.barcode} inputMode="numeric" onChange={(event) => updateLine(line.id, { barcode: event.target.value }, false)} placeholder="Código pendiente" /><button className="btn ghost small" onClick={() => { const checked = validateBarcode(line.barcode); if (!checked.valid || !checked.normalized) return onNotify({ type: "error", text: checked.error || "Ingresá un código válido." }); setPendingBarcode({ lineId: line.id, code: checked.normalized, method: "manual", source: "Escrito y confirmado manualmente" }); }}><Check />Confirmar</button></div></label>
                </div>
                {(!line.barcode || ["requires_confirm_code", "conflict_identifiers"].includes(line.status)) && <div className="code-pending-box"><p><b>No fue posible confirmar el código de barras de este producto.</b> Selecciona una opción para continuar.</p><div><button className="btn secondary small" onClick={() => onRequestScan(line.id)}><Camera />Escanear código</button><label className="btn secondary small"><ImageUp />Subir imagen<input className="native-file-input" type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void readLineImage(line.id, file); }} /></label><button className="btn secondary small" onClick={() => void pasteLineCode(line.id)}><ClipboardPaste />Pegar código</button><button className="btn secondary small" onClick={() => setManualCodeLine(manualCodeLine === line.id ? null : line.id)}><Barcode />Escribir código</button><button className="btn ghost small" onClick={() => void lookupCode(line)} disabled={lookupLineId === line.id}>{lookupLineId === line.id ? <Loader2 className="spin" /> : <Search />}Buscar código</button></div>{manualCodeLine === line.id && <div className="manual-code-row"><input value={line.barcode} inputMode="numeric" onChange={(event) => updateLine(line.id, { barcode: event.target.value }, false)} placeholder="Escribí 8, 12, 13 o 14 dígitos" /><button className="btn primary small" onClick={() => { const checked = validateBarcode(line.barcode); if (!checked.valid || !checked.normalized) return onNotify({ type: "error", text: checked.error || "Código inválido." }); setPendingBarcode({ lineId: line.id, code: checked.normalized, method: "manual", source: "Escrito y confirmado manualmente" }); }}>Revisar</button></div>}</div>}
                {lookupMessages[line.id] && <div className={`lookup-results ${lineCandidates.length ? "has-results" : ""}`}><p>{lookupMessages[line.id]}</p>{lineCandidates.map((candidate) => <button key={`${candidate.code}-${candidate.source}`} onClick={() => setPendingBarcode({ lineId: line.id, code: candidate.code, method: "external_source", source: `${candidate.source}: ${candidate.sourceUrl}` })}><span><b>{candidate.code} · {candidate.type}</b><small>{candidate.title}{candidate.presentation ? ` · ${candidate.presentation}` : ""}</small>{candidate.differences.map((difference) => <em key={difference}>{difference}</em>)}</span><strong>{candidate.confidence}%<small>Confirmar</small></strong></button>)}</div>}
                {line.warnings.map((warning) => <div className="alert warning line-warning" key={warning}><AlertCircle />{warning}</div>)}
                <div className="quantity-preview"><span><small>Existencia actual</small><b>{line.match?.source === "inventory" ? currentQuantity : line.action === "move" || line.action === "create" ? 0 : "—"}</b></span><span><small>Se agregará</small><b>+{line.totalToAdd}</b></span><span><small>Existencia resultante</small><b>{line.match?.source === "inventory" || ["move", "create"].includes(line.action) ? resultingQuantity : "—"}</b></span></div>
                {line.status === "non_inventory" && <div className="alert success"><PackagePlus />Al confirmar: Mover a inventario y agregar cantidad. Sus precios y demás datos permanecerán sin cambios.</div>}
                {line.status === "new_product" && <div className="new-product-choice"><button className={`btn small ${line.action === "create" ? "primary" : "secondary"}`} onClick={() => updateLine(line.id, { action: "create", matchProductId: null, matchNonInventoryId: null })}><Plus />Crear producto sin precios</button></div>}
              </article>;
            })}
          </div>
          <p className="split-help">Para distribuir un set entre productos diferentes, agregá una línea por componente y marcá la línea original como Ignorada.</p>
          {blockedSelected.length > 0 && <div className="alert error"><AlertCircle />{blockedSelected.length} línea{blockedSelected.length === 1 ? " seleccionada necesita" : "s seleccionadas necesitan"} revisión antes de confirmar.</div>}
          <div className="intake-footer"><button className="btn secondary" onClick={() => void saveDraft()} disabled={savingDraft}>{savingDraft ? <Loader2 className="spin" /> : <Save />}Guardar revisión</button><button className="btn primary" onClick={() => void confirmIngreso()} disabled={confirming || !selectedLines.length || blockedSelected.length > 0 || Boolean(pendingVerification)}>{confirming ? <Loader2 className="spin" /> : <ShieldCheck />}Confirmar ingreso ({selectedLines.reduce((total, line) => total + line.totalToAdd, 0)} unidades)</button></div>
        </>}
      </section>}

      {tab === "history" && <section className="intake-pane intake-history">
        <div className="intake-intro"><FileClock /><div><h3>Historial de movimientos</h3><p>Cada ingreso conserva la existencia anterior, la cantidad agregada y la existencia resultante.</p></div><button className="btn secondary small" onClick={() => void loadHistory()} disabled={historyLoading}>{historyLoading ? <Loader2 className="spin" /> : <RotateCcw />}Actualizar</button></div>
        {historyLoading && !history.length ? <div className="recent-loading"><Loader2 className="spin" />Cargando historial…</div> : !history.length ? <p className="empty-summary">Todavía no hay ingresos registrados.</p> : <div className="operation-list">{history.map((operation) => <article className={operation.operationType === "reversal" ? "reversal" : ""} key={operation.id}><header><div><b>{operation.operationType === "reversal" ? "Reversión" : operation.fileName}</b><small>{new Date(operation.confirmedAt).toLocaleString("es-CR")} · {operation.confirmedBy || "Usuario"}</small></div><span>{operation.totalUnits > 0 ? "+" : ""}{operation.totalUnits} unidades</span></header>{operation.invoiceNumber && <p>Factura {operation.invoiceNumber}{operation.shipmentNumber ? ` · envío ${operation.shipmentNumber}` : ""}</p>}<div className="movement-list">{operation.movements.map((movement) => <div key={movement.id}><span><b>{movement.productName}</b><small>{movement.barcode || "Sin código"}</small></span><span>{movement.previousQuantity} <b>{movement.quantityChange >= 0 ? "+" : "−"} {Math.abs(movement.quantityChange)}</b> = {movement.resultingQuantity}</span></div>)}</div>{operation.operationType !== "reversal" && !operation.reversed && <button className="btn danger-outline small" onClick={() => { setReverseTarget(operation); setReverseReason(""); }}><RotateCcw />Revertir ingreso</button>}{operation.reversed && <small className="reversed-label">Este ingreso ya fue revertido mediante un movimiento contrario.</small>}</article>)}</div>}
      </section>}
    </div>

    {pendingBarcode && <div className="nested-modal" role="alertdialog" aria-modal="true"><div className="confirm-card barcode-confirm"><div className="download-symbol"><Barcode /></div><h2>Confirmar código detectado</h2><p>Verificá el número antes de guardarlo. No se utilizará hasta que lo confirmés.</p><strong>{pendingBarcode.code}</strong><small>{validateBarcode(pendingBarcode.code).type}</small><div className="confirm-actions"><button className="btn secondary" onClick={() => setPendingBarcode(null)}>Cancelar</button><button className="btn primary" onClick={confirmPendingBarcode}><Check />Confirmar código</button></div></div></div>}
    {reverseTarget && <div className="nested-modal" role="dialog" aria-modal="true"><div className="confirm-card reverse-card"><div className="delete-symbol"><RotateCcw /></div><h2>Revertir ingreso</h2><p>Se creará un movimiento contrario sin borrar el historial original. Si ya se vendieron unidades y no hay suficiente inventario, la operación se bloqueará.</p><label className="field"><span>Razón de la reversión</span><textarea value={reverseReason} onChange={(event) => setReverseReason(event.target.value)} placeholder="Ej. cantidad ingresada incorrectamente" /></label><div className="confirm-actions"><button className="btn secondary" onClick={() => setReverseTarget(null)} disabled={reversing}>Cancelar</button><button className="btn danger-solid" onClick={() => void reverseOperation()} disabled={reversing || reverseReason.trim().length < 3}>{reversing ? <Loader2 className="spin" /> : <RotateCcw />}Crear reversión</button></div></div></div>}
  </div>;
}
