"use client";

import {
  AlertCircle,
  ArchiveRestore,
  Bell,
  BellRing,
  Calculator,
  Camera,
  Check,
  ChevronDown,
  CircleDollarSign,
  ClipboardPaste,
  Cloud,
  Clock3,
  Delete as DeleteKey,
  Download,
  FileSpreadsheet,
  Flashlight,
  ImageUp,
  Loader2,
  MapPin,
  Minus,
  Package,
  PackageSearch,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  ScanLine,
  Search,
  Settings,
  Trash2,
  Truck,
  Upload,
  Weight,
  WifiOff,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Image from "next/image";
import { InventoryIntakeModal, type IntakeScanEvent } from "./inventory-intake";
import { NotificationCenter } from "./notification-center";
import { OrdersView, type OrderScanEvent } from "./orders-view";
import type { ImportChangedProduct, ImportJobRecord } from "@/lib/import-jobs";
import type { ProductDeletionJobRecord } from "@/lib/deletion-jobs";
import { NUTRIPLUS_PUBLIC_VERSION } from "@/lib/public-version";
import { runSpreadsheetWorker } from "@/lib/spreadsheet-import-client";
import { installAppNavigation, type AppSection, type NavigationController } from "@/lib/app-navigation";
import type { SpreadsheetCellWarning, SpreadsheetParseResult } from "@/lib/spreadsheet-import-parser";
import { spreadsheetImportErrorMessage, validateSpreadsheetFile } from "@/lib/spreadsheet-import-security";
import {
  calculatePrices,
  crc,
  DEFAULT_SETTINGS,
  hasCompletePricing,
  normalizeName,
  type NonInventoryRecord,
  type PricingSettings,
  type ProductRecord,
  searchProducts,
  usd,
} from "@/lib/pricing";
import {
  enqueueMutation,
  listQueuedMutations,
  loadOfflineSnapshot,
  remapQueuedResource,
  removeQueuedMutation,
  saveOfflineSnapshot,
  type QueuedMutation,
} from "@/lib/offline-store";

type Tab = "calculator" | "orders" | "products" | "import" | "settings";
type NumericField = "purchasePriceUsd" | "weightLb" | "code";
type ScannerIntent = "assign" | "lookup-products" | "lookup-calculator" | "floating" | "intake" | "orders";
type Form = {
  id: number | null;
  source: "inventory" | "no_inventory" | null;
  name: string;
  code: string;
  purchasePriceUsd: string;
  weightLb: string;
  quantityAvailable: string;
  minimumStock: string;
  minimumStockEnabled: boolean;
  addToInventory: boolean;
};
type Toast = { type: "success" | "info" | "error" | "warning"; title?: string; text: string; sticky?: boolean; dismissOnPageTouch?: boolean; durationMs?: number } | null;
type Mapping = {
  name: string;
  purchasePriceUsd: string;
  weightLb: string;
  code: string;
  quantityAvailable: string;
  minimumStock: string;
};
type BurstState = { text: string; startedAt: number; lastAt: number; valueBefore: string };
type RecentItem = { source: "inventory"; item: ProductRecord } | { source: "no_inventory"; item: NonInventoryRecord };
type ExportFormat = "excel" | "pdf" | "both";

const EMPTY: Form = {
  id: null,
  source: null,
  name: "",
  code: "",
  purchasePriceUsd: "",
  weightLb: "0",
  quantityAvailable: "",
  minimumStock: "",
  minimumStockEnabled: false,
  addToInventory: false,
};
const EMPTY_BURST: BurstState = { text: "", startedAt: 0, lastAt: 0, valueBefore: "" };
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", ".", "backspace"] as const;

let scannerModulePromise: Promise<typeof import("@zxing/browser")> | null = null;
function preloadScanner() {
  scannerModulePromise ??= import("@zxing/browser");
  return scannerModulePromise;
}

type BarcodeResult = { rawValue: string; format?: string };
type BarcodeDetectorInstance = { detect: (source: HTMLVideoElement | ImageBitmap) => Promise<BarcodeResult[]> };
type BarcodeDetectorConstructor = {
  new (options?: { formats?: string[] }): BarcodeDetectorInstance;
  getSupportedFormats?: () => Promise<string[]>;
};

const BARCODE_FORMATS = [
  "qr_code",
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "code_128",
  "code_39",
  "code_93",
  "codabar",
  "itf",
  "data_matrix",
  "aztec",
  "pdf417",
];

function validDecodedCode(value: string) {
  const clean = value.trim();
  return clean.length >= 3
    && clean.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(clean)
    && /[A-Za-z0-9]/.test(clean);
}

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new ApiError(body.error || "Ocurrió un error inesperado.", response.status, body as Record<string, unknown>);
  return body;
}

class ApiError extends Error {
  constructor(message: string, public status: number, public payload: Record<string, unknown>) { super(message); }
}

function mutationId() {
  return globalThis.crypto?.randomUUID?.() || `np-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function decodeBarcodeImage(file: File) {
  const Detector = (globalThis as typeof globalThis & { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
  if (Detector && "createImageBitmap" in globalThis) {
    try {
      const bitmap = await createImageBitmap(file);
      const supported = Detector.getSupportedFormats ? await Detector.getSupportedFormats().catch(() => BARCODE_FORMATS) : BARCODE_FORMATS;
      const formats = BARCODE_FORMATS.filter((format) => supported.includes(format));
      try {
        const results = await new Detector(formats.length ? { formats } : undefined).detect(bitmap);
        const value = results.find((candidate) => validDecodedCode(candidate.rawValue))?.rawValue;
        if (value) return value.trim();
      } finally { bitmap.close(); }
    } catch {
      // Si el lector nativo no puede abrir la imagen, se intenta con el lector alternativo.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const scannerModule = await preloadScanner();
    const result = await new scannerModule.BrowserMultiFormatReader().decodeFromImageUrl(url);
    const value = result.getText().trim();
    if (!validDecodedCode(value)) throw new Error();
    return value;
  } catch {
    throw new Error("No se encontró ningún código de barras o QR válido en la imagen.");
  } finally { URL.revokeObjectURL(url); }
}

function productToForm(product: ProductRecord): Form {
  return {
    id: product.id,
    source: "inventory",
    name: product.name,
    code: product.code || "",
    purchasePriceUsd: product.purchasePriceUsd === null ? "" : String(product.purchasePriceUsd),
    weightLb: product.weightLb === null ? "" : String(product.weightLb),
    quantityAvailable: String(product.quantityAvailable),
    minimumStock: String(product.minimumStock),
    minimumStockEnabled: product.minimumStockEnabled,
    addToInventory: true,
  };
}

function quoteToForm(quote: NonInventoryRecord): Form {
  return {
    id: quote.id,
    source: "no_inventory",
    name: quote.name,
    code: quote.code || "",
    purchasePriceUsd: quote.purchasePriceUsd === null ? "" : String(quote.purchasePriceUsd),
    weightLb: quote.weightLb === null ? "" : String(quote.weightLb),
    quantityAvailable: "",
    minimumStock: "",
    minimumStockEnabled: false,
    addToInventory: false,
  };
}

function normalizeCode(value: string | null | undefined) {
  return (value || "").trim().toLowerCase().replace(/\s+/g, "");
}

function parseQuantityText(value: string) {
  const entries = new Map<string, { code: string; quantityAdded: number }>();
  const invalidLines: number[] = [];
  value.split(/\r?\n/).forEach((source, index) => {
    const line = source.trim();
    if (!line) return;
    const match = line.match(/^(.+?)(?:\s*[:=;\t]\s*|\s{2,})(\d+)\s*$/);
    const code = match?.[1]?.trim() || "";
    const quantityAdded = Number(match?.[2]);
    if (!code || !Number.isInteger(quantityAdded) || quantityAdded < 0) {
      invalidLines.push(index + 1);
      return;
    }
    const normalized = normalizeCode(code);
    const previous = entries.get(normalized);
    entries.set(normalized, { code: previous?.code || code, quantityAdded: (previous?.quantityAdded ?? 0) + quantityAdded });
  });
  return { entries: [...entries.values()], invalidLines };
}

function remapTemporaryUrl(url: string, productIds: Map<number, number>, quoteIds: Map<number, number>) {
  const productMatch = url.match(/^\/api\/products\/(-\d+)(\/.*)?$/);
  if (productMatch) {
    const realId = productIds.get(Number(productMatch[1]));
    if (realId) return `/api/products/${realId}${productMatch[2] || ""}`;
  }
  const quoteMatch = url.match(/^\/api\/quotes\/(-\d+)(\/.*)?$/);
  if (quoteMatch) {
    const realId = quoteIds.get(Number(quoteMatch[1]));
    if (realId) return `/api/quotes/${realId}${quoteMatch[2] || ""}`;
  }
  return url;
}

function mergeRecentItems(products: ProductRecord[], quotes: NonInventoryRecord[], limit = 40): RecentItem[] {
  const recent: RecentItem[] = [];
  let productIndex = 0;
  let quoteIndex = 0;
  while (recent.length < limit && (productIndex < products.length || quoteIndex < quotes.length)) {
    const product = products[productIndex];
    const quote = quotes[quoteIndex];
    if (!quote || (product && product.updatedAt.localeCompare(quote.updatedAt) >= 0)) {
      recent.push({ source: "inventory", item: product! });
      productIndex += 1;
    } else {
      recent.push({ source: "no_inventory", item: quote });
      quoteIndex += 1;
    }
  }
  return recent;
}

function detectScannerBurst(
  event: ReactKeyboardEvent<HTMLInputElement>,
  state: MutableRefObject<BurstState>,
  onCode: (code: string, valueBefore: string) => void,
) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.nativeEvent.isComposing) return;
  const now = performance.now();
  if (event.key === "Enter" || event.key === "Tab") {
    const duration = state.current.lastAt - state.current.startedAt;
    const isScanner = state.current.text.length >= 4
      && now - state.current.lastAt < 180
      && duration <= Math.max(650, state.current.text.length * 75);
    if (isScanner) {
      event.preventDefault();
      onCode(state.current.text, state.current.valueBefore);
    }
    state.current = { ...EMPTY_BURST };
    return;
  }
  if (event.key.length !== 1) return;
  if (now - state.current.lastAt > 95) {
    state.current = { text: event.key, startedAt: now, lastAt: now, valueBefore: event.currentTarget.value };
  } else {
    state.current.text += event.key;
    state.current.lastAt = now;
  }
}

function Scanner({ onClose, onCode }: { onClose: () => void; onCode: (value: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const torchOnRef = useRef(false);
  const autoTorchEnabledRef = useRef(true);
  const torchBusyRef = useRef(false);
  const onCodeRef = useRef(onCode);
  const lockedRef = useRef(false);
  const candidateRef = useRef({ value: "", count: 0, lastSeen: 0 });
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(true);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  useEffect(() => { onCodeRef.current = onCode; }, [onCode]);

  const confirmCandidate = useCallback((rawValue: string) => {
    const value = rawValue.trim();
    if (lockedRef.current || !validDecodedCode(value)) return;
    const now = performance.now();
    const previous = candidateRef.current;
    if (previous.value === value && now - previous.lastSeen < 900) {
      candidateRef.current = { value, count: previous.count + 1, lastSeen: now };
    } else {
      candidateRef.current = { value, count: 1, lastSeen: now };
    }
    if (candidateRef.current.count < 2) return;
    lockedRef.current = true;
    onCodeRef.current(value);
  }, []);

  const applyTorch = useCallback(async (next: boolean, automatic = false) => {
    const track = stream.current?.getVideoTracks()[0];
    if (!track || torchBusyRef.current) return;
    torchBusyRef.current = true;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      torchOnRef.current = next;
      if (!automatic) autoTorchEnabledRef.current = false;
      setTorchOn(next);
    } catch {
      setTorchAvailable(false);
    } finally {
      torchBusyRef.current = false;
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    let controls: { stop: () => void } | undefined;
    let lightTimer: number | undefined;
    let nativeScanTimer: number | undefined;
    let fallbackTimer: number | undefined;

    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("camera-unavailable");
        const mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30, max: 60 },
          },
        });
        if (stopped || !video.current) {
          mediaStream.getTracks().forEach((track) => track.stop());
          return;
        }

        stream.current = mediaStream;
        video.current.srcObject = mediaStream;
        await video.current.play();
        if (stopped) return;
        setStarting(false);

        const track = mediaStream.getVideoTracks()[0];
        const capabilities = track?.getCapabilities?.() as MediaTrackCapabilities & {
          torch?: boolean;
          focusMode?: string[];
          exposureMode?: string[];
          whiteBalanceMode?: string[];
        };
        const supportsTorch = Boolean(capabilities?.torch);
        setTorchAvailable(supportsTorch);

        const cameraTuning: MediaTrackConstraintSet & Record<string, unknown> = {};
        if (capabilities?.focusMode?.includes("continuous")) cameraTuning.focusMode = "continuous";
        if (capabilities?.exposureMode?.includes("continuous")) cameraTuning.exposureMode = "continuous";
        if (capabilities?.whiteBalanceMode?.includes("continuous")) cameraTuning.whiteBalanceMode = "continuous";
        if (Object.keys(cameraTuning).length) void track.applyConstraints({ advanced: [cameraTuning] }).catch(() => undefined);

        if (supportsTorch) {
          const checkLight = () => {
            const source = video.current;
            const target = canvas.current;
            if (!source || !target || source.readyState < 2) return;
            const context = target.getContext("2d", { willReadFrequently: true });
            if (!context) return;
            target.width = 40;
            target.height = 30;
            context.drawImage(source, 0, 0, 40, 30);
            const pixels = context.getImageData(0, 0, 40, 30).data;
            let brightness = 0;
            let samples = 0;
            let veryDark = 0;
            for (let i = 0; i < pixels.length; i += 16) {
              const luminance = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
              brightness += luminance;
              if (luminance < 48) veryDark += 1;
              samples += 1;
            }
            const average = brightness / Math.max(1, samples);
            const darkRatio = veryDark / Math.max(1, samples);
            if ((average < 70 || darkRatio > 0.72) && !torchOnRef.current && autoTorchEnabledRef.current) {
              void applyTorch(true, true);
            }
          };
          window.setTimeout(checkLight, 45);
          window.setTimeout(checkLight, 120);
          lightTimer = window.setInterval(checkLight, 180);
        }

        const startZxing = async () => {
          if (stopped || controls || !video.current) return;
          const scannerModule = await preloadScanner();
          if (stopped || controls || !video.current) return;
          const reader = new scannerModule.BrowserMultiFormatReader(undefined, {
            delayBetweenScanAttempts: 25,
            delayBetweenScanSuccess: 120,
          });
          controls = await reader.decodeFromStream(mediaStream, video.current, (result) => {
            if (result && !stopped) {
              confirmCandidate(result.getText());
            }
          });
        };

        const Detector = (globalThis as typeof globalThis & { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
        if (Detector) {
          const supported = Detector.getSupportedFormats ? await Detector.getSupportedFormats().catch(() => BARCODE_FORMATS) : BARCODE_FORMATS;
          const formats = BARCODE_FORMATS.filter((format) => supported.includes(format));
          const detector = new Detector(formats.length ? { formats } : undefined);
          const scanNative = async () => {
            if (stopped || !video.current) return;
            try {
              const results = await detector.detect(video.current);
              const result = results.find((candidate) => validDecodedCode(candidate.rawValue));
              if (result && !stopped) confirmCandidate(result.rawValue);
            } catch {
              // A frame can fail while the camera adjusts focus; keep scanning.
            }
            if (!stopped) nativeScanTimer = window.setTimeout(() => void scanNative(), 35);
          };
          void scanNative();
          fallbackTimer = window.setTimeout(() => { void startZxing().catch(() => undefined); }, 700);
        } else {
          await startZxing();
        }
      } catch {
        if (!stopped) {
          setStarting(false);
          setError("No se pudo abrir la cámara. Revisá el permiso o ingresá el código manualmente.");
        }
      }
    })();

    return () => {
      stopped = true;
      if (lightTimer) window.clearInterval(lightTimer);
      if (nativeScanTimer) window.clearTimeout(nativeScanTimer);
      if (fallbackTimer) window.clearTimeout(fallbackTimer);
      controls?.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
    };
  }, [applyTorch, confirmCandidate]);

  return <div className="modal scanner-modal" role="dialog" aria-modal="true" aria-label="Escáner de producto" onPointerDown={onClose}><div className="scanner-card">
    <div className="modal-head"><div><span className="eyebrow">Cámara</span><h2>Escanear producto</h2></div><button className="icon-btn" onClick={onClose} aria-label="Cerrar"><X /></button></div>
    <div className="camera" onPointerDown={onClose}><video ref={video} muted playsInline /><canvas ref={canvas} hidden /><div className="scan-frame" />{starting && <div className="camera-state"><Loader2 className="spin" />Abriendo cámara…</div>}</div>
    {error ? <p className="alert error"><AlertCircle size={17} />{error}</p> : <div className="scanner-help"><p className="hint">Colocá el QR o código de barras dentro del recuadro.</p>{torchAvailable && <button className={`torch-btn ${torchOn ? "active" : ""}`} onClick={() => { autoTorchEnabledRef.current = false; void applyTorch(!torchOn); }}><Flashlight />{torchOn ? "Apagar linterna" : "Encender linterna"}</button>}</div>}
    {torchAvailable && <p className="auto-light">La linterna se activa automáticamente si detecta poca luz. Tocá la cámara o el fondo para cerrarla.</p>}
    <button className="btn secondary full" onClick={onClose}>Cancelar</button>
  </div></div>;
}

function StickyPrices({ price, weight, settings }: { price: number | null; weight: number | null; settings: PricingSettings }) {
  const [open, setOpen] = useState(false);
  const detailsRef = useRef<HTMLDivElement>(null);
  const complete = price !== null && Number.isFinite(price) && price >= 0 && weight !== null && Number.isFinite(weight) && weight >= 0;
  const result = complete ? calculatePrices(price, weight, settings) : null;
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!detailsRef.current?.contains(event.target as Node)) setOpen(false); };
    const closeOnScroll = () => setOpen(false);
    document.addEventListener("pointerdown", close, true);
    window.addEventListener("scroll", closeOnScroll, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", close, true);
      window.removeEventListener("scroll", closeOnScroll);
    };
  }, [open]);
  return <header className="price-bar"><div className="price-bar-inner">
    <div className="sticky-price gam"><MapPin /><span>GAM</span><strong>{result ? crc(result.gamPriceCrc) : "—"}</strong></div>
    <div className="sticky-price port"><Truck /><span>Puerto</span><strong>{result ? crc(result.puertoPriceCrc) : "—"}</strong></div>
    <div className={`sticky-details ${open ? "open" : ""}`} ref={detailsRef}><button type="button" className="details-toggle" onClick={() => setOpen((current) => !current)}>{open ? "Ocultar" : "Ver desglose"} <ChevronDown /></button>{open && <div className="sticky-breakdown">
      {result ? <div className="breakdown">
        <div><span>Peso ingresado</span><b>{weight?.toFixed(2)} lb</b></div><div><span>Peso cobrado (+{settings.extraWeightLb.toFixed(2)})</span><b>{result.chargedWeightLb.toFixed(2)} lb</b></div>
        <div><span>Courier</span><b>{usd(result.courierUsd)}</b></div><div><span>Compra + courier</span><b>{usd(result.merchandiseAndCourierUsd)}</b></div>
        <div><span>Entrega + Correos</span><b>{crc(settings.deliveryCrc + settings.correosCrc)}</b></div><div className="total"><span>Precio costo</span><b>{crc(result.costCrc)}</b></div>
      </div> : <p className="pending-note"><AlertCircle />Ingresá el precio de compra y el peso para ver el desglose.</p>}
    </div>}</div>
  </div></header>;
}

function NumericKeypad({ active, onKey, onClose }: { active: NumericField; onKey: (key: typeof KEYS[number]) => void; onClose: () => void }) {
  const label = active === "purchasePriceUsd" ? "precio" : active === "weightLb" ? "peso" : "código";
  return <div className="numeric-keypad" data-keypad-zone aria-label="Teclado numérico"><div className="keypad-head"><span>Ingresando {label}</span><button type="button" onClick={onClose} aria-label="Ocultar teclado"><X /></button></div><div className="keypad-grid">
    {KEYS.map((key) => <button type="button" key={key} onPointerDown={(event) => event.preventDefault()} onClick={() => onKey(key)} aria-label={key === "backspace" ? "Borrar último número" : key}>{key === "backspace" ? <DeleteKey /> : key}</button>)}
  </div></div>;
}

type ProductFormProps = {
  form: Form;
  setForm: (next: Form | ((current: Form) => Form)) => void;
  settings: PricingSettings;
  suggestions: ProductRecord[];
  suggestionsOpen: boolean;
  setSuggestionsOpen: (open: boolean) => void;
  onPick: (product: ProductRecord) => void;
  onExternalCode: (code: string) => void;
  onOpenScanner: () => void;
  onImageCode: (file: File) => Promise<void>;
  onPasteCode: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel?: () => void;
  saving: boolean;
  activeNumeric: NumericField | null;
  setActiveNumeric: (field: NumericField | null) => void;
  showSuggestions?: boolean;
};

function ProductForm({
  form,
  setForm,
  settings,
  suggestions,
  suggestionsOpen,
  setSuggestionsOpen,
  onPick,
  onExternalCode,
  onOpenScanner,
  onImageCode,
  onPasteCode,
  onSubmit,
  onCancel,
  saving,
  activeNumeric,
  setActiveNumeric,
  showSuggestions = true,
}: ProductFormProps) {
  const nameBurst = useRef<BurstState>({ ...EMPTY_BURST });
  const imageInput = useRef<HTMLInputElement>(null);
  const price = form.purchasePriceUsd.trim() ? Number(form.purchasePriceUsd) : null;
  const weight = form.weightLb.trim() ? Number(form.weightLb) : null;
  const validPrice = price === null || (Number.isFinite(price) && price >= 0);
  const validWeight = weight === null || (Number.isFinite(weight) && weight >= 0);
  const quantityAvailable = form.quantityAvailable.trim() ? Number(form.quantityAvailable) : 0;
  const minimumStock = form.minimumStockEnabled && form.minimumStock.trim() ? Number(form.minimumStock) : 0;
  const validInventory = Number.isInteger(quantityAvailable) && quantityAvailable >= 0 && Number.isInteger(minimumStock) && minimumStock >= 0;
  const completePricing = price !== null && validPrice && weight !== null && validWeight;
  const validForm = Boolean(form.name.trim()) && validPrice && validWeight && validInventory;

  function keypad(key: typeof KEYS[number]) {
    if (!activeNumeric) return;
    setForm((current) => {
      const existing = current[activeNumeric];
      let next = existing;
      if (key === "backspace") next = existing.slice(0, -1);
      else if (key === ".") next = existing.includes(".") ? existing : `${existing || (activeNumeric === "code" ? "" : "0")}.`;
      else if (existing.length < (activeNumeric === "code" ? 256 : 10)) next = activeNumeric === "code" ? `${existing}${key}` : existing === "0" ? key : `${existing}${key}`;
      return { ...current, [activeNumeric]: next };
    });
  }

  return <form className="surface form-card" onSubmit={onSubmit} onPointerDown={(event) => { if (!(event.target as HTMLElement).closest("[data-keypad-zone]")) setActiveNumeric(null); }}>{form.id && <div className="edit-banner"><Pencil />{form.source === "no_inventory" ? "Editando producto de No inventario" : "Editando producto guardado"}</div>}
    <label className="field name-field"><span>Nombre del producto <em>*</em></span><div className="input-icon"><Package /><input value={form.name} onChange={(event) => { setForm({ ...form, name: event.target.value }); setSuggestionsOpen(true); }} onKeyDown={(event) => detectScannerBurst(event, nameBurst, (code, before) => { setForm((current) => ({ ...current, name: before, code })); onExternalCode(code); })} onFocus={() => setSuggestionsOpen(true)} onBlur={() => window.setTimeout(() => setSuggestionsOpen(false), 160)} placeholder="Ej. Omega 3 Nordic encargo" required /></div>{showSuggestions && suggestionsOpen && form.name.trim() && suggestions.length > 0 && <div className="suggestions"><small>Productos encontrados</small>{suggestions.slice(0, 7).map((product) => <button type="button" onMouseDown={() => onPick(product)} key={product.id}><b>{product.name}</b><span>{product.purchasePriceUsd === null ? "Compra incompleta" : usd(product.purchasePriceUsd)} · {product.weightLb === null ? "peso incompleto" : `${product.weightLb.toFixed(2)} lb`}</span></button>)}</div>}<p className="hint">Podés buscar con varias palabras aunque no estén seguidas.</p></label>
    <div className="field"><span>Código QR o de barras <small>Opcional</small></span><div className="code-row"><div className={`input-icon grow ${activeNumeric === "code" ? "active" : ""}`} data-keypad-zone><ScanLine /><input aria-label="Código QR o de barras" value={form.code} inputMode="none" onFocus={() => setActiveNumeric("code")} onClick={() => setActiveNumeric("code")} onChange={(event) => setForm({ ...form, code: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); const code = event.currentTarget.value.trim(); if (code) onExternalCode(code); } }} placeholder="Escaneá, cargá o pegá el código" autoComplete="off" /></div><button type="button" className="scan-btn" onPointerDown={() => void preloadScanner()} onClick={onOpenScanner} title="Escanear con la cámara"><Camera /><span>Escanear</span></button><button type="button" className="scan-btn compact" onClick={() => imageInput.current?.click()} title="Leer código desde una imagen"><ImageUp /><span>Imagen</span></button><button type="button" className="scan-btn compact" onClick={onPasteCode} title="Pegar código copiado"><ClipboardPaste /><span>Pegar</span></button><input ref={imageInput} className="native-file-input" type="file" accept="image/*" onChange={(event) => { const input = event.currentTarget; const file = input.files?.[0]; if (file) void onImageCode(file).finally(() => { input.value = ""; }); }} /></div></div>
    <div className="two"><label className="field"><span>Precio de compra</span><div className={`number-box tappable ${activeNumeric === "purchasePriceUsd" ? "active" : ""}`} data-keypad-zone><i>$</i><input type="text" inputMode="none" readOnly value={form.purchasePriceUsd} onFocus={() => setActiveNumeric("purchasePriceUsd")} onClick={() => setActiveNumeric("purchasePriceUsd")} placeholder="" /></div><p className="hint">En dólares</p></label><label className="field"><span>Peso</span><div className={`number-box tappable ${activeNumeric === "weightLb" ? "active" : ""}`} data-keypad-zone><input type="text" inputMode="none" readOnly value={form.weightLb} onFocus={() => setActiveNumeric("weightLb")} onClick={() => setActiveNumeric("weightLb")} placeholder="" /><small>lb</small></div><p className="hint">Se suman {settings.extraWeightLb.toFixed(2)} lb.</p></label></div>
    {activeNumeric && <NumericKeypad active={activeNumeric} onKey={keypad} onClose={() => setActiveNumeric(null)} />}
    <label className={`inventory-choice ${form.addToInventory ? "enabled" : ""}`}><input type="checkbox" checked={form.addToInventory} disabled={form.source === "inventory"} onChange={(event) => setForm((current) => ({ ...current, addToInventory: event.target.checked }))} /><span><b>Agregar producto al inventario</b><small>{form.source === "inventory" ? "Este producto ya pertenece al inventario." : form.source === "no_inventory" ? (form.addToInventory ? "Al guardar, pasará a Productos y se eliminará de No inventario." : "Marcá esta opción para pasarlo de No inventario al inventario.") : form.addToInventory ? "Aparecerá en Productos y tendrá control de existencias." : "Se guardará en la hoja No inventario y no aparecerá en Productos."}</small></span></label>
    {form.addToInventory && <div className="inventory-fields"><label className="field"><span>Cantidad disponible</span><div className="stock-stepper"><button type="button" onClick={() => setForm((current) => ({ ...current, quantityAvailable: String(Math.max(0, Number(current.quantityAvailable || 0) - 1)) }))} aria-label="Restar una unidad"><Minus /></button><input type="text" inputMode="numeric" value={form.quantityAvailable} onChange={(event) => setForm({ ...form, quantityAvailable: event.target.value.replace(/\D/g, "").slice(0, 7) })} placeholder="0" aria-label="Cantidad disponible" /><button type="button" onClick={() => setForm((current) => ({ ...current, quantityAvailable: String(Number(current.quantityAvailable || 0) + 1) }))} aria-label="Sumar una unidad"><Plus /></button></div></label>
      <label className={`stock-toggle ${form.minimumStockEnabled ? "enabled" : ""}`}><input type="checkbox" checked={form.minimumStockEnabled} onChange={(event) => setForm((current) => ({ ...current, minimumStockEnabled: event.target.checked, minimumStock: event.target.checked ? (current.minimumStock || "0") : "" }))} /><span><b>Controlar stock mínimo</b><small>Activá esta alerta solo para los productos más vendidos.</small></span></label>
      {form.minimumStockEnabled && <label className="field minimum-stock-field"><span>Cantidad para activar la alerta</span><div className="stock-stepper"><button type="button" onClick={() => setForm((current) => ({ ...current, minimumStock: String(Math.max(0, Number(current.minimumStock || 0) - 1)) }))} aria-label="Restar una unidad al stock mínimo"><Minus /></button><input type="text" inputMode="numeric" value={form.minimumStock} onChange={(event) => setForm({ ...form, minimumStock: event.target.value.replace(/\D/g, "").slice(0, 7) })} placeholder="0" aria-label="Stock mínimo" /><button type="button" onClick={() => setForm((current) => ({ ...current, minimumStock: String(Number(current.minimumStock || 0) + 1) }))} aria-label="Sumar una unidad al stock mínimo"><Plus /></button></div><p className="hint">Se avisará cuando la cantidad llegue o baje de este número.</p></label>}
    </div>}
    {!form.name.trim() && (form.purchasePriceUsd || (form.weightLb && form.weightLb !== "0")) && <p className="alert warning"><AlertCircle />Agregá el nombre para guardar.</p>}{form.name.trim() && !completePricing && <p className="alert warning"><AlertCircle />Podés guardarlo como incompleto y completar los datos después.</p>}
    <div className={`form-actions ${onCancel ? "split" : ""}`}>{onCancel && <button type="button" className="btn secondary" onClick={onCancel}>Cancelar</button>}<button className="btn primary" disabled={!validForm || saving}>{saving ? <Loader2 className="spin" /> : <Save />}{completePricing ? (form.id ? "Guardar cambios" : "Guardar cotización") : "Guardar incompleto"}</button></div>
  </form>;
}

function Step({ n, title, text }: { n: string; title: string; text: string }) { return <div className="step"><span>{n}</span><div><h2>{title}</h2><p>{text}</p></div></div>; }

function parseNumber(value: unknown) {
  if (typeof value === "number") return value;
  const clean = String(value ?? "").trim().replace(/[$₡\s]/g, "");
  if (!clean) return null;
  const parsed = clean.includes(",") && clean.includes(".")
    ? Number(clean.replace(/,/g, ""))
    : clean.includes(",")
      ? Number(/^\d{1,3}(,\d{3})+$/.test(clean) ? clean.replace(/,/g, "") : clean.replace(",", "."))
      : Number(clean);
  return Number.isFinite(parsed) ? parsed : null;
}

type ImportViewProps = {
  settings: PricingSettings;
  job: ImportJobRecord | null;
  deletionJob: ProductDeletionJobRecord | null;
  productCount: number;
  history: ImportJobRecord[];
  summary: ImportChangedProduct[];
  restoringId: number | null;
  onStart: (payload: { rows: Array<Record<string, unknown>>; strategy: "update" | "skip"; fileName: string; sheetName: string }) => Promise<void>;
  onRestore: (job: ImportJobRecord) => Promise<void>;
  onDeleteAll: () => Promise<void>;
};

function importDate(value: string) {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  return new Intl.DateTimeFormat("es-CR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(normalized));
}

function ImportView({ settings, job, deletionJob, productCount, history, summary, restoringId, onStart, onRestore, onDeleteAll }: ImportViewProps) {
  const input = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [sheetName, setSheetName] = useState("");
  const [firstDataRow, setFirstDataRow] = useState(2);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<unknown[][]>([]);
  const [formattedRows, setFormattedRows] = useState<string[][]>([]);
  const [rowNumbers, setRowNumbers] = useState<number[]>([]);
  const [cellWarnings, setCellWarnings] = useState<SpreadsheetCellWarning[]>([]);
  const [codeWarningAcknowledged, setCodeWarningAcknowledged] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [sheetOptions, setSheetOptions] = useState<string[]>([]);
  const [selectedSheet, setSelectedSheet] = useState("");
  const [mapping, setMapping] = useState<Mapping>({ name: "", purchasePriceUsd: "", weightLb: "", code: "", quantityAvailable: "", minimumStock: "" });
  const [strategy, setStrategy] = useState<"update" | "skip">("update");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Toast>(null);
  const [restoreTarget, setRestoreTarget] = useState<ImportJobRecord | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [summaryVisibleCount, setSummaryVisibleCount] = useState(4);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const mapped = useMemo(() => rows.map((row, index) => {
    const codeColumn = mapping.code === "" ? null : Number(mapping.code);
    const codeCell = codeColumn === null ? null : (formattedRows[index]?.[codeColumn] ?? row[codeColumn]);
    const quantityCell = mapping.quantityAvailable === "" ? null : row[Number(mapping.quantityAvailable)];
    const minimumCell = mapping.minimumStock === "" ? null : row[Number(mapping.minimumStock)];
    return {
      rowNumber: rowNumbers[index] ?? index + firstDataRow,
      name: mapping.name === "" ? "" : String(row[Number(mapping.name)] ?? "").trim(),
      purchasePriceUsd: mapping.purchasePriceUsd === "" ? null : parseNumber(row[Number(mapping.purchasePriceUsd)]),
      weightLb: mapping.weightLb === "" ? null : parseNumber(row[Number(mapping.weightLb)]),
      code: String(codeCell ?? "").trim(),
      quantityAvailable: parseNumber(quantityCell),
      minimumStock: parseNumber(minimumCell),
      hasCode: mapping.code !== "" && String(codeCell ?? "").trim() !== "",
      hasPurchasePrice: mapping.purchasePriceUsd !== "",
      hasWeight: mapping.weightLb !== "",
      hasQuantity: mapping.quantityAvailable !== "" && String(quantityCell ?? "").trim() !== "",
      hasMinimumStock: mapping.minimumStock !== "" && String(minimumCell ?? "").trim() !== "",
    };
  }), [firstDataRow, formattedRows, mapping, rowNumbers, rows]);
  const named = mapped.filter((row) => row.name);
  const ready = [...new Map(named.map((row) => [normalizeName(row.name), row])).values()];
  const duplicates = named.length - ready.length;
  const incomplete = ready.filter((row) => !row.hasPurchasePrice || row.purchasePriceUsd === null || !row.hasWeight || row.weightLb === null);
  const impreciseCodeWarnings = mapping.code === ""
    ? []
    : cellWarnings.filter((warning) => warning.columnIndex === Number(mapping.code));
  const running = job?.status === "queued" || job?.status === "running";
  const percentage = job ? Math.min(100, Math.round((job.processedRows / Math.max(1, job.totalRows)) * 100)) : 0;
  const deleting = deletionJob?.status === "queued" || deletionJob?.status === "running";
  const deletionPercentage = deletionJob
    ? Math.min(100, Math.round((deletionJob.processedProducts / Math.max(1, deletionJob.totalProducts)) * 100))
    : 0;

  useEffect(() => {
    if (!notice) return;
    const dismiss = () => setNotice(null);
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [notice]);

  useEffect(() => {
    const onBack = (event: Event) => {
      if ((event as CustomEvent<{ section?: string }>).detail?.section !== "import") return;
      if (deleteConfirm) { event.preventDefault(); setDeleteConfirm(false); }
      else if (restoreTarget) { event.preventDefault(); setRestoreTarget(null); }
    };
    window.addEventListener("nutriplus:navigation-back", onBack);
    return () => window.removeEventListener("nutriplus:navigation-back", onBack);
  }, [deleteConfirm, restoreTarget]);

  function applyParsedFile(file: File, parsed: SpreadsheetParseResult) {
    const normalized = parsed.headers.map(normalizeName);
    const find = (...tests: RegExp[]) => {
      const index = normalized.findIndex((head) => tests.some((test) => test.test(head)));
      return index < 0 ? "" : String(index);
    };
    setFileName(file.name);
    setSheetName(parsed.sheetName);
    setFirstDataRow(parsed.rowNumbers[0] ?? 2);
    setHeaders(parsed.headers);
    setRows(parsed.rows);
    setFormattedRows(parsed.formattedRows);
    setRowNumbers(parsed.rowNumbers);
    setCellWarnings(parsed.warnings);
    setCodeWarningAcknowledged(false);
    setPendingFile(null);
    setSheetOptions([]);
    setSelectedSheet("");
    setMapping({
      name: find(/^producto$/, /nombre/, /descripcion/),
      purchasePriceUsd: find(/precio.*compra/, /precio.*producto/, /costo.*usd/, /^precio$/),
      weightLb: find(/^libras$/, /peso.*lb/, /^peso$/, /^lb$/),
      code: find(/codigo/, /barra/, /barcode/, /^qr$/),
      quantityAvailable: find(/^cant$/, /cantidad.*disponible/, /existencia/, /stock.*actual/),
      minimumStock: find(/stock.*minimo/, /cantidad.*minima/, /^minimo$/),
    });
  }

  async function readSelectedFile(file: File, requestedSheet?: string) {
    setBusy(true);
    setNotice(null);
    try {
      const { buffer } = await validateSpreadsheetFile(file);
      const parsed = await runSpreadsheetWorker(buffer, requestedSheet);
      if (parsed.status === "select_sheet") {
        setPendingFile(file);
        setFileName(file.name);
        setSheetOptions(parsed.sheetNames);
        setSelectedSheet(parsed.sheetNames[0] || "");
        return;
      }
      applyParsedFile(file, parsed);
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : spreadsheetImportErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    await readSelectedFile(file);
    event.target.value = "";
  }

  const reset = () => {
    setHeaders([]);
    setRows([]);
    setFormattedRows([]);
    setRowNumbers([]);
    setCellWarnings([]);
    setCodeWarningAcknowledged(false);
    setPendingFile(null);
    setSheetOptions([]);
    setSelectedSheet("");
    setFileName("");
    setSheetName("");
    setNotice(null);
  };

  async function beginImport() {
    setBusy(true);
    setNotice(null);
    setSummaryVisibleCount(4);
    try {
      await onStart({ rows: ready, strategy, fileName, sheetName });
      reset();
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "No se pudo iniciar la importación." });
    } finally {
      setBusy(false);
    }
  }

  return <div className="view"><header className="view-head"><span className="eyebrow">Carga masiva segura</span><h1>Importar Excel</h1><p>Las importaciones y eliminaciones continúan aunque cambiés de sección. Cada operación crea un respaldo antes de modificar productos.</p></header>

    {deletionJob && deletionJob.status !== "completed" && <section className={`surface import-progress deletion-progress ${deletionJob.status}`}><div className="progress-head"><div><span className="eyebrow">{deleting ? "Eliminando en segundo plano" : "La eliminación encontró un problema"}</span><h2>Productos guardados</h2><p>{deletionJob.processedProducts} de {deletionJob.totalProducts} productos revisados{deletionJob.preservedProducts ? ` · ${deletionJob.preservedProducts} cambios recientes conservados` : ""}</p></div><strong>{`${deletionPercentage}%`}</strong></div><div className="progress-track danger-track" aria-label={`${deletionPercentage}% eliminado`}><span style={{ width: `${deletionPercentage}%` }} /></div>{deleting && <p className="background-note"><Loader2 className="spin" />Podés preparar e iniciar otro Excel. La importación quedará en espera y empezará automáticamente cuando termine esta eliminación.</p>}</section>}

    {job && job.status !== "completed" && <section className={`surface import-progress ${job.status}`}><div className="progress-head"><div><span className="eyebrow">{running ? deleting && job.status === "queued" ? "Importación en espera segura" : "Importando en segundo plano" : "La importación encontró un problema"}</span><h2>{job.fileName}</h2><p>{job.sheetName ? `Hoja ${job.sheetName} · ` : ""}{job.processedRows} de {job.totalRows} productos procesados</p></div><strong>{`${percentage}%`}</strong></div><div className="progress-track" aria-label={`${percentage}% importado`}><span style={{ width: `${percentage}%` }} /></div><div className="progress-stats"><span><b>{job.importedCount}</b>Nuevos</span><span><b>{job.updatedCount}</b>Actualizados</span><span><b>{job.skippedCount}</b>Omitidos</span><span><b>{job.conflictCount + job.errorCount}</b>Sin cambiar</span></div>{running && <p className="background-note"><Loader2 className="spin" />{deleting && job.status === "queued" ? "El archivo ya quedó guardado. Empezará automáticamente cuando termine esta eliminación." : "Podés seguir usando Calcular, Productos o Ajustes. Guardar un producto manualmente no detiene ni sobrescribe tu cambio."}</p>}</section>}

    {!running && (!headers.length ? (sheetOptions.length && pendingFile ? <section className="surface upload sheet-selection"><div className="upload-icon"><FileSpreadsheet /></div><h2>Elegí la hoja que contiene los productos</h2><p>{fileName} tiene varias hojas y ninguna se llama Compu o Solo Compu.</p><label className="field"><span>Hoja a importar</span><select value={selectedSheet} onChange={(event) => setSelectedSheet(event.target.value)}>{sheetOptions.map((name) => <option value={name} key={name}>{name}</option>)}</select></label><div className="sheet-selection-actions"><button className="btn secondary" onClick={reset} disabled={busy}><RotateCcw />Cambiar archivo</button><button className="btn primary" onClick={() => void readSelectedFile(pendingFile, selectedSheet)} disabled={busy || !selectedSheet}>{busy ? <Loader2 className="spin" /> : <Check />}Usar esta hoja</button></div></section> : <section className="surface upload"><div className="upload-icon"><FileSpreadsheet /></div><h2>{busy ? "Leyendo archivo en segundo plano…" : "Seleccioná tu archivo"}</h2><p>.xlsx, .xlsm, .xls o .csv · máximo 10 MiB</p><label className={`btn primary ${busy ? "disabled" : ""}`} htmlFor="nutriplus-import-file">{busy ? <Loader2 className="spin" /> : <Upload />}Elegir archivo</label><input id="nutriplus-import-file" className="native-file-input" ref={input} type="file" accept=".xlsx,.xlsm,.xls,.csv" onChange={pick} disabled={busy} /></section>) : <>
      <section className="surface file-row"><div><FileSpreadsheet /><span><b>{fileName}</b><small>Hoja {sheetName} · {named.length} filas con producto</small></span></div><button className="btn ghost small" onClick={reset}><RotateCcw />Cambiar</button></section>
      <section className="surface section"><Step n="1" title="Relacioná las columnas" text="Solo Producto es obligatorio. Las demás columnas se importan si están disponibles." /><div className="mapping">{([["name", "Nombre del producto", true], ["code", "Código QR / barras", false], ["purchasePriceUsd", "Precio de compra USD", false], ["weightLb", "Peso en libras", false], ["quantityAvailable", "Cantidad disponible", false], ["minimumStock", "Stock mínimo", false]] as const).map(([key, label, required]) => <label className="field" key={key}><span>{label}{required && <em>*</em>}</span><select value={mapping[key]} onChange={(event) => { setMapping({ ...mapping, [key]: event.target.value }); if (key === "code") setCodeWarningAcknowledged(false); }}><option value="">No importar esta columna</option>{headers.map((header, index) => <option value={index} key={`${header}-${index}`}>{header}</option>)}</select></label>)}</div></section>
      <section className="surface section"><Step n="2" title="Cómo tratar los productos existentes" text={`${ready.length} productos listos · ${incomplete.length} incompletos${duplicates ? ` · ${duplicates} repetidos: se conservará la última aparición` : ""}. No se mostrará vista previa.`} />{impreciseCodeWarnings.length > 0 && <div className="alert warning code-warning"><AlertCircle /><span><b>Revisá {impreciseCodeWarnings.length === 1 ? "un código largo" : `${impreciseCodeWarnings.length} códigos largos`} antes de importar.</b><small>Excel guardó {impreciseCodeWarnings.length === 1 ? "ese valor" : "esos valores"} como número de más de 15 dígitos y puede haber perdido precisión. Filas: {impreciseCodeWarnings.slice(0, 8).map((warning) => warning.rowNumber).join(", ")}{impreciseCodeWarnings.length > 8 ? "…" : ""}.</small><label><input type="checkbox" checked={codeWarningAcknowledged} onChange={(event) => setCodeWarningAcknowledged(event.target.checked)} />Confirmo que revisé los códigos en el archivo original.</label></span></div>}<div className="strategies"><label className={strategy === "update" ? "chosen" : ""}><input type="radio" checked={strategy === "update"} onChange={() => setStrategy("update")} /><span><b>Actualizar existentes</b><small>Solo reemplaza las columnas incluidas. Los cambios manuales posteriores se conservan.</small></span></label><label className={strategy === "skip" ? "chosen" : ""}><input type="radio" checked={strategy === "skip"} onChange={() => setStrategy("skip")} /><span><b>Omitir existentes</b><small>Agrega únicamente productos nuevos.</small></span></label></div><button className="btn primary full" disabled={mapping.name === "" || !ready.length || busy || (impreciseCodeWarnings.length > 0 && !codeWarningAcknowledged)} onClick={() => void beginImport()}>{busy ? <Loader2 className="spin" /> : <Upload />}Importar {ready.length || ""} productos</button></section>
    </>)}

    {job?.status === "completed" && <section className="surface section import-summary"><Step n="✓" title="Resumen de la última importación" text={`${job.importedCount} nuevos · ${job.updatedCount} actualizados · ${job.incompleteCount} incompletos`} />{summary.length ? <><div className="summary-list">{summary.slice(0, summaryVisibleCount).map(({ outcome, product }) => { const prices = hasCompletePricing(product) ? calculatePrices(product.purchasePriceUsd, product.weightLb, settings) : null; return <article key={`${outcome}-${product.id}`}><div><b>{product.name}</b><small>{outcome === "imported" ? "Nuevo" : "Actualizado"}{product.code ? ` · ${product.code}` : ""}</small></div><span><small>Stock</small><b>{product.quantityAvailable}{product.minimumStockEnabled ? ` / mín. ${product.minimumStock}` : ""}</b></span><span><small>GAM</small><b>{prices ? crc(prices.gamPriceCrc) : "Incompleto"}</b></span><span><small>Puerto</small><b>{prices ? crc(prices.puertoPriceCrc) : "Incompleto"}</b></span></article>; })}</div>{summaryVisibleCount < summary.length && <button className="btn secondary summary-toggle" onClick={() => setSummaryVisibleCount((current) => current + 5)}>Ver {Math.min(5, summary.length - summaryVisibleCount)} más</button>}</> : <p className="empty-summary">No hubo productos nuevos ni actualizados en esta importación.</p>}</section>}

    <section className="surface section delete-catalog"><Step n="!" title="Borrar productos actuales" text="Vacía únicamente el catálogo de productos. Los ajustes y el historial permanecen, y se crea un respaldo restaurable antes de comenzar." /><button className="btn danger-outline full" onClick={() => setDeleteConfirm(true)} disabled={!productCount || deleting || running}><Trash2 />{deleting ? "Eliminando productos…" : productCount ? `Borrar los ${productCount} productos` : "No hay productos para borrar"}</button>{running && <p className="delete-help">Esperá a que termine la importación activa para iniciar una eliminación.</p>}</section>

    <section className="surface section import-history"><Step n="↶" title="Historial y respaldos" text="Cada importación conserva una copia completa del inventario anterior." />{history.length ? <><div className="history-list">{history.slice(0, historyExpanded ? history.length : 2).map((item) => <article key={item.id}><div><b>{item.fileName}</b><small>{importDate(item.createdAt)}{item.restoredAt ? " · Restaurado" : ""}</small></div><span><b>{item.backupProductCount} productos</b><small>{item.strategy === "backup" ? "Respaldo automático" : `${item.importedCount} nuevos · ${item.updatedCount} actualizados`}</small></span><button className="btn ghost small" onClick={() => setRestoreTarget(item)} disabled={restoringId !== null || item.status !== "completed"}><ArchiveRestore />Volver a este respaldo</button></article>)}</div>{history.length > 2 && <button className="btn secondary summary-toggle" onClick={() => setHistoryExpanded((current) => !current)}>{historyExpanded ? "Ver menos" : `Ver más (${history.length - 2})`}</button>}</> : <p className="empty-summary">El historial aparecerá después de la primera importación.</p>}</section>
    {notice && <div className={`toast ${notice.type}`} role="status"><AlertCircle /><span>{notice.title && <b>{notice.title}</b>}<small>{notice.text}</small></span><button onClick={() => setNotice(null)} aria-label="Cerrar notificación"><X /></button></div>}
    {deleteConfirm && <div className="modal" role="dialog" aria-modal="true" aria-label="Confirmar eliminación de todos los productos"><div className="confirm-card"><div className="delete-symbol"><Trash2 /></div><h2>¿Borrar todos los productos?</h2><p>Se eliminarán <b>{productCount} productos</b>. Antes se guardará un respaldo para recuperarlos desde el historial si fuera necesario.</p><div className="confirm-actions"><button className="btn secondary" onClick={() => setDeleteConfirm(false)}>No, cancelar</button><button className="btn danger-solid" onClick={() => { setDeleteConfirm(false); void onDeleteAll(); }}><Trash2 />Sí, borrar todos</button></div></div></div>}
    {restoreTarget && <div className="modal" role="dialog" aria-modal="true" aria-label="Confirmar restauración"><div className="confirm-card"><div className="download-symbol"><ArchiveRestore /></div><h2>¿Volver a este respaldo?</h2><p>Se restaurará el inventario que existía antes de <b>{restoreTarget.fileName}</b>. Primero se guardará otra copia del inventario actual para que también puedas recuperarlo.</p><div className="confirm-actions"><button className="btn secondary" onClick={() => setRestoreTarget(null)} disabled={restoringId !== null}>No, cancelar</button><button className="btn primary" onClick={() => { const target = restoreTarget; setRestoreTarget(null); void onRestore(target); }} disabled={restoringId !== null}><ArchiveRestore />Sí, restaurar</button></div></div></div>}
  </div>;
}

function SettingsView({ current, onSave }: { current: PricingSettings; onSave: (value: PricingSettings) => Promise<void> }) {
  const [draft, setDraft] = useState<Record<keyof PricingSettings, string>>(() => Object.fromEntries(
    (Object.keys(current) as Array<keyof PricingSettings>).map((key) => [key, String(current[key])]),
  ) as Record<keyof PricingSettings, string>);
  const [busy, setBusy] = useState(false);
  const fields: Array<[keyof PricingSettings, string, string, string, string]> = [
    ["exchangeRateCrc", "Tipo de cambio", "₡", "por $1", "1"],
    ["courierRateUsd", "Costo de courier", "$", "por lb", "0.01"],
    ["extraWeightLb", "Peso adicional", "", "lb", "0.01"],
    ["deliveryCrc", "Costo de entrega", "₡", "", "1"],
    ["correosCrc", "Correos de Costa Rica", "₡", "", "1"],
    ["gamProfitCrc", "Ganancia GAM", "₡", "", "1"],
    ["puertoProfitCrc", "Ganancia Puerto", "₡", "", "1"],
    ["roundingCrc", "Redondeo hacia arriba", "₡", "", "1"],
  ];
  const validDraft = fields.every(([key]) => {
    if (!draft[key].trim()) return false;
    const value = Number(draft[key]);
    return Number.isFinite(value) && value >= 0 && (key !== "roundingCrc" || value >= 1);
  });
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!validDraft) return;
    const parsed = Object.fromEntries(fields.map(([key]) => [key, Number(draft[key])])) as PricingSettings;
    setBusy(true);
    try { await onSave(parsed); } finally { setBusy(false); }
  }
  return <div className="view"><header className="view-head"><span className="eyebrow">Valores generales</span><h1>Ajustes</h1><p>Los cambios recalculan todos los productos guardados.</p></header><form className="surface settings-form" onSubmit={submit}><div className="mapping">{fields.map(([key, label, prefix, suffix, step]) => <label className="field" key={key}><span>{label}</span><div className="number-box">{prefix && <i>{prefix}</i>}<input type="number" min="0" step={step} value={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />{suffix && <small>{suffix}</small>}</div></label>)}</div>{!validDraft && <p className="alert warning"><AlertCircle />Completá todos los valores antes de guardar.</p>}<div className="settings-note"><CircleDollarSign /><span>Se conservan el precio de compra y el peso; los precios de venta se actualizan con estos valores.</span></div><button className="btn primary full" disabled={busy || !validDraft}>{busy ? <Loader2 className="spin" /> : <Save />}Guardar ajustes</button></form></div>;
}

function Empty({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) { return <div className="empty">{icon}<h2>{title}</h2>{text && <p>{text}</p>}</div>; }

function initialTab(): Tab {
  if (typeof window === "undefined") return "calculator";
  const requested = new URLSearchParams(window.location.search).get("tab");
  return ["calculator", "orders", "products", "import", "settings"].includes(requested || "") ? requested as Tab : "calculator";
}

export function NutriPlusApp() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [calculatorForm, setCalculatorForm] = useState<Form>(EMPTY);
  const [productForm, setProductForm] = useState<Form>({ ...EMPTY, addToInventory: true });
  const [products, setProducts] = useState<ProductRecord[]>([]);
  const [quotes, setQuotes] = useState<NonInventoryRecord[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [scannerIntent, setScannerIntent] = useState<ScannerIntent | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [activeNumeric, setActiveNumeric] = useState<NumericField | null>(null);
  const [productEditorOpen, setProductEditorOpen] = useState(false);
  const [restockOpen, setRestockOpen] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  const [recentItems, setRecentItems] = useState<RecentItem[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);
  const [noInventoryOpen, setNoInventoryOpen] = useState(false);
  const [noInventoryQuery, setNoInventoryQuery] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ProductRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedProductIds, setSelectedProductIds] = useState<Set<number>>(new Set());
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [inventoryIntakeOpen, setInventoryIntakeOpen] = useState(false);
  const [quantityText, setQuantityText] = useState("");
  const [intakeScanTarget, setIntakeScanTarget] = useState<string | null>(null);
  const [intakeScannedBarcode, setIntakeScannedBarcode] = useState<IntakeScanEvent>(null);
  const [orderScannedBarcode, setOrderScannedBarcode] = useState<OrderScanEvent>(null);
  const [exportConfirm, setExportConfirm] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("both");
  const [visibleCount, setVisibleCount] = useState(36);
  const [importJob, setImportJob] = useState<ImportJobRecord | null>(null);
  const [importHistory, setImportHistory] = useState<ImportJobRecord[]>([]);
  const [importSummary, setImportSummary] = useState<ImportChangedProduct[]>([]);
  const [restoringImportId, setRestoringImportId] = useState<number | null>(null);
  const [deletionJob, setDeletionJob] = useState<ProductDeletionJobRecord | null>(null);
  const [isOnline, setIsOnline] = useState(true);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [exitConfirmOpen, setExitConfirmOpen] = useState(false);
  const deferredQuery = useDeferredValue(query);
  const deferredNoInventoryQuery = useDeferredValue(noInventoryQuery);
  const searchBurst = useRef<BurstState>({ ...EMPTY_BURST });
  const importRunners = useRef<Set<number>>(new Set());
  const deletionRunners = useRef<Set<number>>(new Set());
  const nextTemporaryProductId = useRef(-1);
  const nextTemporaryQuoteId = useRef(-1);
  const notificationProductHandled = useRef(false);
  const navigation = useRef<NavigationController | null>(null);
  const tabRef = useRef<Tab>(tab);
  const scrollByTab = useRef<Record<Tab, number>>({ calculator: 0, orders: 0, products: 0, import: 0, settings: 0 });
  const closeTopLayer = useRef<() => boolean>(() => false);

  const notify = useCallback((next: NonNullable<Toast>) => {
    setToast(next);
  }, []);

  const activateTab = useCallback((next: AppSection) => {
    const previous = tabRef.current;
    if (previous === next) return;
    scrollByTab.current[previous] = window.scrollY;
    tabRef.current = next;
    setActiveNumeric(null);
    setTab(next);
    window.requestAnimationFrame(() => window.scrollTo({ top: scrollByTab.current[next], behavior: "auto" }));
  }, []);

  const navigateTab = useCallback((next: Tab) => {
    if (navigation.current) navigation.current.navigate(next);
    else activateTab(next);
  }, [activateTab]);

  useEffect(() => {
    const controller = installAppNavigation(window.history, window, tabRef.current, {
      onSection: activateTab,
      onBeforeBack: () => closeTopLayer.current(),
      onRequestExit: () => setExitConfirmOpen(true),
    });
    navigation.current = controller;
    return () => {
      controller.dispose();
      if (navigation.current === controller) navigation.current = null;
    };
  }, [activateTab]);

  useEffect(() => {
    if (!toast) return;
    const dismiss = () => setToast(null);
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [toast]);

  useEffect(() => {
    if (!activeNumeric) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as HTMLElement | null)?.closest?.("[data-keypad-zone]")) setActiveNumeric(null);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [activeNumeric]);

  const clearCalculatorForm = useCallback(() => {
    setCalculatorForm(EMPTY);
    setActiveNumeric(null);
    setSuggestionsOpen(false);
  }, []);

  const clearProductForm = useCallback(() => {
    setProductForm({ ...EMPTY, addToInventory: true });
    setProductEditorOpen(false);
    setActiveNumeric(null);
  }, []);

  useEffect(() => {
    closeTopLayer.current = () => {
      if (scannerIntent) { setScannerIntent(null); return true; }
      if (bulkDeleteConfirm) { setBulkDeleteConfirm(false); return true; }
      if (deleteTarget) { setDeleteTarget(null); return true; }
      if (exportConfirm) { setExportConfirm(false); return true; }
      if (inventoryIntakeOpen) { setInventoryIntakeOpen(false); return true; }
      if (recentOpen) { setRecentOpen(false); return true; }
      if (noInventoryOpen) { setNoInventoryOpen(false); return true; }
      if (restockOpen) { setRestockOpen(false); return true; }
      const nestedBack = new CustomEvent("nutriplus:navigation-back", { cancelable: true, detail: { section: tabRef.current } });
      window.dispatchEvent(nestedBack);
      if (nestedBack.defaultPrevented) return true;
      if (tabRef.current === "products" && productEditorOpen) { setProductEditorOpen(false); return true; }
      if (tabRef.current === "products" && selectionMode) { setSelectionMode(false); setSelectedProductIds(new Set()); return true; }
      if (activeNumeric) { setActiveNumeric(null); return true; }
      return false;
    };
    return () => { closeTopLayer.current = () => false; };
  }, [activeNumeric, bulkDeleteConfirm, deleteTarget, exportConfirm, inventoryIntakeOpen, noInventoryOpen, productEditorOpen, recentOpen, restockOpen, scannerIntent, selectionMode]);

  const refreshProducts = useCallback(async () => {
    const result = await json<{ products: ProductRecord[] }>(await fetch("/api/products?limit=5000"));
    setProducts(result.products);
  }, []);

  const refreshQuotes = useCallback(async () => {
    const result = await json<{ quotes: NonInventoryRecord[] }>(await fetch("/api/quotes?limit=5000"));
    setQuotes(result.quotes);
  }, []);

  const queueOfflineMutation = useCallback(async (mutation: QueuedMutation) => {
    await enqueueMutation(mutation);
    const queued = await listQueuedMutations();
    setPendingSyncCount(queued.length);
  }, []);

  const flushOfflineMutations = useCallback(async () => {
    if (!navigator.onLine) return;
    const execute = async () => {
      if (syncing) return;
      setSyncing(true);
      let synchronized = 0;
      const productIds = new Map<number, number>();
      const quoteIds = new Map<number, number>();
      try {
        const queued = await listQueuedMutations();
        setPendingSyncCount(queued.length);
        for (const mutation of queued) {
          const url = remapTemporaryUrl(mutation.url, productIds, quoteIds);
          let response: Response;
          try {
            response = await fetch(url, {
              method: mutation.method,
              headers: { "Content-Type": "application/json", "X-Mutation-Id": mutation.id, ...(mutation.headers || {}) },
              body: mutation.method === "DELETE" ? undefined : JSON.stringify({ ...(mutation.body || {}), mutationId: mutation.id }),
            });
          } catch { break; }
          const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
          if (!response.ok) {
            if (response.status === 409) {
              const movingQuote = url.endsWith("/move-to-inventory");
              if (movingQuote) {
                const current = payload.current as NonInventoryRecord | undefined;
                setProducts((items) => items.filter((item) => item.id !== mutation.tempId));
                if (current) setQuotes((items) => [current, ...items.filter((item) => item.id !== current.id)]);
              }
              await removeQueuedMutation(mutation.id);
              setPendingSyncCount((count) => Math.max(0, count - 1));
              notify({ type: "warning", text: String(payload.error || "Se conservó la información más reciente."), dismissOnPageTouch: false, durationMs: 5000 });
              continue;
            }
            break;
          }
          if (payload.product) {
            const product = payload.product as ProductRecord;
            if (typeof mutation.tempId === "number" && mutation.tempId < 0) {
              productIds.set(mutation.tempId, product.id);
              await remapQueuedResource("product", mutation.tempId, product.id);
            }
            setProducts((items) => [product, ...items.filter((item) => item.id !== product.id && item.id !== mutation.tempId)]);
            const removedQuoteId = Number(payload.removedQuoteId || 0);
            if (removedQuoteId) setQuotes((items) => items.filter((item) => item.id !== removedQuoteId));
          } else if (Array.isArray(payload.products)) {
            const updated = payload.products as ProductRecord[];
            const updatedIds = new Set(updated.map((product) => product.id));
            setProducts((items) => [...updated, ...items.filter((item) => !updatedIds.has(item.id))]);
          } else if (payload.quote) {
            const quote = payload.quote as NonInventoryRecord;
            if (typeof mutation.tempId === "number" && mutation.tempId < 0) {
              quoteIds.set(mutation.tempId, quote.id);
              await remapQueuedResource("quote", mutation.tempId, quote.id);
            }
            setQuotes((items) => [quote, ...items.filter((item) => item.id !== quote.id && item.id !== mutation.tempId)]);
          } else if (Array.isArray(payload.deletedIds)) {
            const deletedIds = new Set((payload.deletedIds as unknown[]).map(Number));
            setProducts((items) => items.filter((item) => !deletedIds.has(item.id)));
          } else if (payload.deleted) {
            const productId = Number(url.match(/^\/api\/products\/(\d+)/)?.[1]);
            const quoteId = Number(url.match(/^\/api\/quotes\/(\d+)/)?.[1]);
            if (productId) setProducts((items) => items.filter((item) => item.id !== productId));
            if (quoteId) setQuotes((items) => items.filter((item) => item.id !== quoteId));
          }
          if (payload.settings) setSettings(payload.settings as PricingSettings);
          await removeQueuedMutation(mutation.id);
          synchronized += 1;
          setPendingSyncCount((count) => Math.max(0, count - 1));
        }
        if (synchronized) {
          await Promise.all([refreshProducts(), refreshQuotes()]).catch(() => undefined);
          notify({ type: "success", text: `${synchronized} cambio${synchronized === 1 ? "" : "s"} sin conexión sincronizado${synchronized === 1 ? "" : "s"}.`, dismissOnPageTouch: false, durationMs: 3000 });
        }
      } finally { setSyncing(false); }
    };
    const locks = (navigator as Navigator & { locks?: { request: (name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<void>) => Promise<void> } }).locks;
    if (locks) await locks.request("nutriplus-offline-sync", { ifAvailable: true }, async (lock) => { if (lock) await execute(); });
    else await execute();
  }, [notify, refreshProducts, refreshQuotes, syncing]);

  const refreshImportHistory = useCallback(async () => {
    const result = await json<{ jobs: ImportJobRecord[] }>(await fetch("/api/imports"));
    setImportHistory(result.jobs);
    return result.jobs;
  }, []);

  const runImport = useCallback(async (id: number) => {
    if (importRunners.current.has(id)) return;
    importRunners.current.add(id);
    try {
      while (true) {
        const data = await json<{ job: ImportJobRecord; waitingForDeletion?: boolean }>(await fetch(`/api/imports/${id}/process`, { method: "POST" }));
        setImportJob(data.job);
        if (data.job.status === "completed") {
          const detail = await json<{ job: ImportJobRecord; changedProducts: ImportChangedProduct[] }>(await fetch(`/api/imports/${id}`));
          setImportJob(detail.job);
          setImportSummary(detail.changedProducts);
          await Promise.all([refreshProducts(), refreshImportHistory()]);
          notify({ type: "success", text: `Importación completada: ${detail.job.importedCount} nuevos y ${detail.job.updatedCount} actualizados.`, dismissOnPageTouch: false, durationMs: 3000 });
          break;
        }
        if (data.job.status === "failed") {
          await refreshImportHistory();
          notify({ type: "error", text: "La importación se detuvo sin borrar el inventario anterior. Podés revisar el respaldo en Importar.", dismissOnPageTouch: false, durationMs: 3000 });
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, data.waitingForDeletion ? 220 : 35));
      }
    } catch (error) {
      notify({ type: "error", text: error instanceof Error ? `${error.message} La importación quedó guardada para poder reanudarla.` : "La importación quedó guardada para poder reanudarla.", dismissOnPageTouch: false, durationMs: 3000 });
    } finally { importRunners.current.delete(id); }
  }, [notify, refreshImportHistory, refreshProducts]);

  const runDeletion = useCallback(async (id: number) => {
    if (deletionRunners.current.has(id)) return;
    deletionRunners.current.add(id);
    try {
      while (true) {
        const data = await json<{ job: ProductDeletionJobRecord; waitingForImport?: boolean }>(await fetch(`/api/products/delete-all/${id}/process`, { method: "POST" }));
        setDeletionJob(data.job);
        if (data.job.status === "completed") {
          await Promise.all([refreshProducts(), refreshImportHistory()]);
          notify({ type: "success", text: `Eliminación completada: ${data.job.deletedProducts} productos borrados${data.job.preservedProducts ? ` y ${data.job.preservedProducts} cambios recientes conservados` : ""}.`, dismissOnPageTouch: false, durationMs: 3000 });
          break;
        }
        if (data.job.status === "failed") {
          notify({ type: "error", text: "La eliminación se detuvo. El respaldo permanece disponible en Importar.", dismissOnPageTouch: false, durationMs: 3000 });
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, data.waitingForImport ? 220 : 35));
      }
    } catch (error) {
      notify({ type: "error", text: error instanceof Error ? `${error.message} El proceso quedó guardado para reanudarlo.` : "La eliminación quedó guardada para reanudarla.", dismissOnPageTouch: false, durationMs: 3000 });
    } finally { deletionRunners.current.delete(id); }
  }, [notify, refreshImportHistory, refreshProducts]);

  const startImport = useCallback(async (payload: { rows: Array<Record<string, unknown>>; strategy: "update" | "skip"; fileName: string; sheetName: string }) => {
    const data = await json<{ job: ImportJobRecord }>(await fetch("/api/imports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }));
    setImportJob(data.job);
    setImportSummary([]);
    setImportHistory((current) => [data.job, ...current.filter((item) => item.id !== data.job.id)]);
    notify({ type: "success", text: "La importación empezó en segundo plano. Podés seguir usando la app." });
    void runImport(data.job.id);
  }, [notify, runImport]);

  const startDeletion = useCallback(async () => {
    try {
      const data = await json<{ job: ProductDeletionJobRecord }>(await fetch("/api/products/delete-all", { method: "POST" }));
      setDeletionJob(data.job);
      notify({ type: "success", text: "La eliminación empezó en segundo plano. Ya podés preparar el próximo Excel." });
      if (data.job.status !== "completed") void runDeletion(data.job.id);
    } catch (error) {
      notify({ type: "error", text: error instanceof Error ? error.message : "No se pudo iniciar la eliminación.", sticky: true });
    }
  }, [notify, runDeletion]);

  const restoreImport = useCallback(async (target: ImportJobRecord) => {
    setRestoringImportId(target.id);
    try {
      const result = await json<{ restored: boolean; products: number }>(await fetch(`/api/imports/${target.id}/restore`, { method: "POST" }));
      await Promise.all([refreshProducts(), refreshImportHistory()]);
      setImportSummary([]);
      notify({ type: "success", text: `Respaldo restaurado: ${result.products} productos recuperados. También se guardó una copia del inventario que tenías antes de restaurar.`, sticky: true });
    } catch (error) {
      notify({ type: "error", text: error instanceof Error ? error.message : "No se pudo restaurar el respaldo.", sticky: true });
    } finally {
      setRestoringImportId(null);
    }
  }, [notify, refreshImportHistory, refreshProducts]);

  useEffect(() => {
    const preloadTimer = window.setTimeout(() => { void preloadScanner().catch(() => undefined); }, 700);
    (async () => {
      try {
        setIsOnline(navigator.onLine);
        const [settingsResponse, productsResponse, quotesResponse, importsResponse, deletionsResponse] = await Promise.all([fetch("/api/settings"), fetch("/api/products?limit=5000"), fetch("/api/quotes?limit=5000"), fetch("/api/imports"), fetch("/api/products/delete-all")]);
        const settingsData = await json<{ settings: PricingSettings }>(settingsResponse);
        const productsData = await json<{ products: ProductRecord[] }>(productsResponse);
        const quotesData = await json<{ quotes: NonInventoryRecord[] }>(quotesResponse);
        const importsData = await json<{ jobs: ImportJobRecord[] }>(importsResponse);
        const deletionsData = await json<{ jobs: ProductDeletionJobRecord[] }>(deletionsResponse);
        setSettings(settingsData.settings);
        setProducts(productsData.products);
        setQuotes(quotesData.quotes);
        setImportHistory(importsData.jobs);
        const activeDeletion = deletionsData.jobs.find((item) => item.status === "queued" || item.status === "running");
        const latestDeletion = activeDeletion || deletionsData.jobs[0] || null;
        setDeletionJob(latestDeletion);
        if (activeDeletion) void runDeletion(activeDeletion.id);
        const activeImports = importsData.jobs
          .filter((item) => item.strategy !== "backup" && (item.status === "queued" || item.status === "running"))
          .sort((left, right) => left.id - right.id);
        const latest = activeImports.at(-1) || importsData.jobs.find((item) => item.strategy !== "backup") || importsData.jobs[0] || null;
        setImportJob(latest);
        if (activeImports.length) activeImports.forEach((item) => { void runImport(item.id); });
        else if (latest?.status === "completed" && latest.strategy !== "backup") {
          void json<{ job: ImportJobRecord; changedProducts: ImportChangedProduct[] }>(await fetch(`/api/imports/${latest.id}`)).then((detail) => setImportSummary(detail.changedProducts)).catch(() => undefined);
        }
      } catch (error) {
        const snapshot = await loadOfflineSnapshot().catch(() => undefined);
        if (snapshot) {
          setSettings(snapshot.settings);
          setProducts(snapshot.products);
          setQuotes(snapshot.quotes || []);
          setIsOnline(false);
          notify({ type: "warning", text: "La app abrió con la última copia guardada. Los cambios se sincronizarán cuando vuelva Internet.", dismissOnPageTouch: false, durationMs: 5000 });
        } else {
          notify({ type: "error", text: error instanceof Error ? error.message : "No se pudo iniciar la app." });
        }
      } finally {
        setLoading(false);
      }
    })();
    return () => window.clearTimeout(preloadTimer);
  }, [notify, runDeletion, runImport]);

  useEffect(() => {
    if (loading) return;
    const timer = window.setTimeout(() => {
      void saveOfflineSnapshot({ settings, products, quotes, savedAt: new Date().toISOString() });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [loading, products, quotes, settings]);

  useEffect(() => {
    const online = () => { setIsOnline(true); void flushOfflineMutations(); };
    const offline = () => setIsOnline(false);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    void listQueuedMutations().then((items) => { setPendingSyncCount(items.length); if (navigator.onLine && items.length) void flushOfflineMutations(); });
    return () => { window.removeEventListener("online", online); window.removeEventListener("offline", offline); };
  }, [flushOfflineMutations]);

  const suggestions = useMemo(() => searchProducts(products, calculatorForm.name).filter((product) => product.id !== calculatorForm.id).slice(0, 8), [calculatorForm.id, calculatorForm.name, products]);
  const lowStockProducts = useMemo(() => products.filter((product) =>
    (product.minimumStockEnabled && product.quantityAvailable <= product.minimumStock) || Boolean(product.zeroStockSince),
  ), [products]);
  const pendingRestockProducts = useMemo(() => lowStockProducts.filter((product) => !product.restockPurchasedAt), [lowStockProducts]);
  const filteredProducts = useMemo(() => {
    return searchProducts(products, deferredQuery);
  }, [deferredQuery, products]);
  const filteredNoInventory = useMemo(() => searchProducts(quotes, deferredNoInventoryQuery), [deferredNoInventoryQuery, quotes]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      if (params.get("stock") === "low") setRestockOpen(true);
      if (params.get("notifications") === "1") window.dispatchEvent(new Event("nutriplus:open-notifications"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const fillCalculator = useCallback((product: ProductRecord) => {
    setCalculatorForm(productToForm(product));
    setActiveNumeric(null);
    setSuggestionsOpen(false);
    navigateTab("calculator");
  }, [navigateTab]);

  const editInProducts = useCallback((product: ProductRecord) => {
    setProductForm(productToForm(product));
    setProductEditorOpen(true);
    setRestockOpen(false);
    setRecentOpen(false);
    setNoInventoryOpen(false);
    setActiveNumeric(null);
    setSuggestionsOpen(false);
    navigateTab("products");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [navigateTab]);

  useEffect(() => {
    if (loading || notificationProductHandled.current) return;
    const productTimer = window.setTimeout(() => {
      const requestedId = Number(new URLSearchParams(window.location.search).get("product"));
      if (!Number.isInteger(requestedId) || requestedId < 1) {
        notificationProductHandled.current = true;
        return;
      }
      notificationProductHandled.current = true;
      const requestedProduct = products.find((product) => product.id === requestedId);
      if (requestedProduct) editInProducts(requestedProduct);
    }, 0);
    return () => window.clearTimeout(productTimer);
  }, [editInProducts, loading, products]);

  const editNoInventory = useCallback((quote: NonInventoryRecord) => {
    setCalculatorForm(quoteToForm(quote));
    setNoInventoryOpen(false);
    setRecentOpen(false);
    setActiveNumeric(null);
    setSuggestionsOpen(false);
    navigateTab("calculator");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [navigateTab]);

  const addInProducts = useCallback(() => {
    setProductForm({ ...EMPTY, addToInventory: true });
    setProductEditorOpen(true);
    setRestockOpen(false);
    setActiveNumeric(null);
    setSuggestionsOpen(false);
    navigateTab("products");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [navigateTab]);

  const markRestock = useCallback(async (product: ProductRecord, purchased: boolean) => {
    const now = purchased ? new Date().toISOString() : null;
    setProducts((items) => items.map((item) => item.id === product.id ? { ...item, restockPurchasedAt: now, version: item.version + 1, updatedAt: new Date().toISOString() } : item));
    const id = mutationId();
    const mutation: QueuedMutation = { id, method: "PATCH", url: `/api/products/${product.id}/restock`, body: { purchased }, createdAt: new Date().toISOString() };
    if (!navigator.onLine) {
      await queueOfflineMutation(mutation);
      return;
    }
    try {
      const data = await json<{ product: ProductRecord }>(await fetch(mutation.url, { method: "PATCH", headers: { "Content-Type": "application/json", "X-Mutation-Id": id }, body: JSON.stringify({ purchased, mutationId: id }) }));
      setProducts((items) => [data.product, ...items.filter((item) => item.id !== data.product.id)]);
    } catch (error) {
      if (!navigator.onLine || error instanceof TypeError) await queueOfflineMutation(mutation);
      else notify({ type: "error", text: error instanceof Error ? error.message : "No se pudo cambiar el estado de compra." });
    }
  }, [notify, queueOfflineMutation]);

  const openRecent = useCallback(async () => {
    setRecentOpen(true);
    const local = mergeRecentItems(products, quotes);
    setRecentItems(local);
    setRecentLoading(local.length === 0);
    try {
      const data = await json<{ items: RecentItem[] }>(await fetch("/api/recent?limit=40"));
      setRecentItems(data.items);
    } catch {
      // La lista local ya está visible; la actualización remota se reintentará al volver a abrirla.
    } finally { setRecentLoading(false); }
  }, [products, quotes]);

  const assignCode = useCallback((code: string) => {
    const cleanCode = code.trim();
    if (!cleanCode) return;
    setScannerIntent(null);
    setProductForm((current) => ({ ...current, code: cleanCode }));
    setSuggestionsOpen(false);
    notify({ type: "success", text: "Código agregado. Podés guardar los cambios sin salir de esta pantalla." });
  }, [notify]);

  const lookupCode = useCallback(async (code: string, destination: "products" | "calculator" | "floating") => {
    const cleanCode = code.trim();
    if (!cleanCode) return;
    setScannerIntent(null);
    try {
      let product = products.find((candidate) => normalizeCode(candidate.code) === normalizeCode(cleanCode)) || null;
      if (!product) {
        const data = await json<{ product: ProductRecord | null }>(await fetch(`/api/products?code=${encodeURIComponent(cleanCode)}`));
        product = data.product;
        if (product) setProducts((current) => current.some((candidate) => candidate.id === product!.id) ? current : [product!, ...current]);
      }
      if (product) {
        if (destination === "products" || destination === "floating") {
          editInProducts(product);
        } else {
          fillCalculator(product);
        }
        notify({ type: "success", text: `Encontramos ${product.name}.` });
      } else if (destination === "products" || destination === "floating") {
        setProductForm((current) => ({ ...current, id: null, source: null, code: cleanCode, addToInventory: true }));
        setProductEditorOpen(true);
        setActiveNumeric(null);
        navigateTab("products");
        notify({ type: "success", text: "Código nuevo agregado. Quedará disponible tanto en Productos como en Calcular." });
      } else {
        setCalculatorForm((current) => ({ ...current, code: cleanCode }));
        setActiveNumeric(null);
        navigateTab("calculator");
        notify({ type: "success", text: "Código nuevo agregado sin borrar los datos ingresados." });
      }
    } catch (error) {
      notify({ type: "error", text: error instanceof Error ? error.message : "No se pudo buscar el código." });
    }
  }, [editInProducts, fillCalculator, navigateTab, notify, products]);

  const openScanner = useCallback((intent: ScannerIntent) => {
    setScannerIntent(intent);
  }, []);

  const handleScannerCode = useCallback((code: string) => {
    if (scannerIntent === "assign") assignCode(code);
    else if (scannerIntent === "lookup-products") void lookupCode(code, "products");
    else if (scannerIntent === "lookup-calculator") void lookupCode(code, "calculator");
    else if (scannerIntent === "floating") void lookupCode(code, "floating");
    else if (scannerIntent === "orders") {
      setScannerIntent(null);
      setOrderScannedBarcode({ code, nonce: Date.now() });
    }
    else if (scannerIntent === "intake" && intakeScanTarget) {
      setScannerIntent(null);
      setIntakeScannedBarcode({ lineId: intakeScanTarget, code, nonce: Date.now() });
      setIntakeScanTarget(null);
    }
  }, [assignCode, intakeScanTarget, lookupCode, scannerIntent]);

  const readCodeFromImage = useCallback(async (file: File, intent: "assign" | "calculator" | "products") => {
    try {
      const code = await decodeBarcodeImage(file);
      if (intent === "assign") assignCode(code);
      else await lookupCode(code, intent);
    } catch (error) {
      notify({ type: "error", text: error instanceof Error ? error.message : "No se encontró un código de barras en la imagen." });
    }
  }, [assignCode, lookupCode, notify]);

  const pasteCode = useCallback(async (intent: "assign" | "calculator" | "products") => {
    try {
      const code = (await navigator.clipboard.readText()).trim();
      if (!validDecodedCode(code)) throw new Error("El portapapeles no contiene un código válido.");
      if (intent === "assign") assignCode(code);
      else await lookupCode(code, intent);
    } catch (error) {
      notify({ type: "error", text: error instanceof Error ? error.message : "No se pudo leer el portapapeles. Podés mantener presionada la casilla y pegar manualmente.", sticky: true });
    }
  }, [assignCode, lookupCode, notify]);

  useEffect(() => {
    let buffer = "";
    let startedAt = 0;
    let lastAt = 0;
    const receive = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      const editable = target instanceof HTMLInputElement ? !target.readOnly : target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || Boolean(target?.isContentEditable);
      if (editable) return;
      const now = performance.now();
      if (event.key === "Enter" || event.key === "Tab") {
        const duration = lastAt - startedAt;
        if (buffer.length >= 4 && now - lastAt < 180 && duration <= Math.max(650, buffer.length * 75)) {
          event.preventDefault();
          if (tab === "products" && productEditorOpen) assignCode(buffer);
          else void lookupCode(buffer, tab === "products" ? "products" : "calculator");
        }
        buffer = "";
        return;
      }
      if (event.key.length !== 1) return;
      if (now - lastAt > 95) { buffer = event.key; startedAt = now; } else buffer += event.key;
      lastAt = now;
    };
    window.addEventListener("keydown", receive, true);
    return () => window.removeEventListener("keydown", receive, true);
  }, [assignCode, lookupCode, productEditorOpen, tab]);

  const visibleForm = tab === "products" ? productForm : calculatorForm;
  const price = visibleForm.purchasePriceUsd.trim() ? Number(visibleForm.purchasePriceUsd) : null;
  const weight = visibleForm.weightLb.trim() ? Number(visibleForm.weightLb) : null;
  const validPrice = price === null || (Number.isFinite(price) && price >= 0);
  const validWeight = weight === null || (Number.isFinite(weight) && weight >= 0);
  const showPriceBar = tab === "calculator" || (tab === "products" && productEditorOpen);

  function save(event: FormEvent<HTMLFormElement>, source: "calculator" | "products") {
    event.preventDefault();
    const form = source === "products" ? productForm : calculatorForm;
    const clearForm = source === "products" ? clearProductForm : clearCalculatorForm;
    if (!form.name.trim()) return notify({ type: "error", text: "El nombre del producto es obligatorio." });
    const quantityAvailable = form.quantityAvailable.trim() ? Number(form.quantityAvailable) : 0;
    const minimumStock = form.minimumStockEnabled && form.minimumStock.trim() ? Number(form.minimumStock) : 0;
    if (form.addToInventory && (!Number.isInteger(quantityAvailable) || quantityAvailable < 0 || !Number.isInteger(minimumStock) || minimumStock < 0)) {
      return notify({ type: "error", text: "La cantidad y el stock mínimo deben ser números enteros iguales o mayores que cero." });
    }
    const submittedForm = { ...form, name: form.name.trim(), code: form.code.trim() };
    const saveToInventory = submittedForm.source === "inventory" || submittedForm.addToInventory;
    const existing = submittedForm.source === "inventory" && submittedForm.id !== null
      ? products.find((product) => product.id === submittedForm.id) || null
      : null;
    const existingQuote = submittedForm.source === "no_inventory" && submittedForm.id !== null
      ? quotes.find((quote) => quote.id === submittedForm.id) || null
      : null;
    const now = new Date().toISOString();

    if (submittedForm.source === "no_inventory" && submittedForm.addToInventory && existingQuote) {
      const optimisticId = nextTemporaryProductId.current--;
      const optimistic: ProductRecord = {
        id: optimisticId,
        name: submittedForm.name,
        code: submittedForm.code || null,
        purchasePriceUsd: price,
        weightLb: weight,
        quantityAvailable,
        minimumStock,
        minimumStockEnabled: submittedForm.minimumStockEnabled,
        restockPurchasedAt: null,
        zeroStockSince: quantityAvailable === 0 ? now : null,
        version: 1,
        createdAt: existingQuote.createdAt,
        updatedAt: now,
      };
      setQuotes((current) => current.filter((item) => item.id !== existingQuote.id));
      setProducts((current) => [optimistic, ...current]);
      clearForm();
      notify({ type: "success", text: "Producto agregado." });

      const id = mutationId();
      const mutation: QueuedMutation = {
        id,
        method: "POST",
        url: `/api/quotes/${existingQuote.id}/move-to-inventory`,
        body: {
          name: submittedForm.name,
          code: submittedForm.code,
          purchasePriceUsd: price,
          weightLb: weight,
          quantityAvailable,
          minimumStock,
          minimumStockEnabled: submittedForm.minimumStockEnabled,
          version: existingQuote.version,
        },
        tempId: optimisticId,
        createdAt: now,
      };

      void (async () => {
        if (!navigator.onLine) return queueOfflineMutation(mutation);
        try {
          const data = await json<{ product: ProductRecord | null; removedQuoteId: number; deleted?: boolean }>(await fetch(mutation.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Mutation-Id": id },
            body: JSON.stringify({ ...mutation.body, mutationId: id }),
            keepalive: true,
          }));
          if (data.product) setProducts((current) => [data.product!, ...current.filter((item) => item.id !== optimisticId && item.id !== data.product!.id)]);
          else setProducts((current) => current.filter((item) => item.id !== optimisticId));
          setQuotes((current) => current.filter((item) => item.id !== data.removedQuoteId));
          if (!data.product) notify({ type: "warning", text: "El producto ya había sido procesado o eliminado por otra persona." });
        } catch (error) {
          if (!navigator.onLine || error instanceof TypeError) {
            await queueOfflineMutation(mutation);
            return;
          }
          const currentQuote = error instanceof ApiError && error.payload.current
            ? error.payload.current as NonInventoryRecord
            : existingQuote;
          setProducts((current) => current.filter((item) => item.id !== optimisticId));
          setQuotes((current) => [currentQuote, ...current.filter((item) => item.id !== currentQuote.id)]);
          setCalculatorForm({ ...quoteToForm(currentQuote), addToInventory: true });
          setNoInventoryOpen(false);
          setRecentOpen(false);
          navigateTab("calculator");
          notify({ type: "error", text: error instanceof Error ? error.message : `No se pudo pasar ${submittedForm.name} al inventario.`, sticky: true });
        }
      })();
      return;
    }

    if (!saveToInventory) {
      const optimisticId = existingQuote?.id ?? nextTemporaryQuoteId.current--;
      const optimisticQuote: NonInventoryRecord = {
        id: optimisticId,
        name: submittedForm.name,
        code: submittedForm.code || null,
        purchasePriceUsd: price,
        weightLb: weight,
        version: (existingQuote?.version ?? 0) + 1,
        createdAt: existingQuote?.createdAt ?? now,
        updatedAt: now,
      };
      setQuotes((current) => [optimisticQuote, ...current.filter((item) => item.id !== optimisticId)]);
      clearForm();
      notify({ type: "success", text: "Producto agregado." });
      const id = mutationId();
      const mutation: QueuedMutation = {
        id,
        method: existingQuote ? "PUT" : "POST",
        url: existingQuote ? `/api/quotes/${existingQuote.id}` : "/api/quotes",
        body: { ...submittedForm, purchasePriceUsd: price, weightLb: weight, version: existingQuote?.version },
        tempId: optimisticId,
        createdAt: now,
      };
      void (async () => {
        if (!navigator.onLine) return queueOfflineMutation(mutation);
        try {
          const data = await json<{ quote: NonInventoryRecord | null; deleted?: boolean }>(await fetch(mutation.url, { method: mutation.method, headers: { "Content-Type": "application/json", "X-Mutation-Id": id }, body: JSON.stringify({ ...mutation.body, mutationId: id }), keepalive: true }));
          if (data.quote) setQuotes((current) => [data.quote!, ...current.filter((item) => item.id !== optimisticId && item.id !== data.quote!.id)]);
          else {
            setQuotes((current) => current.filter((item) => item.id !== optimisticId));
            notify({ type: "warning", text: "Ese producto de No inventario ya había sido eliminado o trasladado por otra persona." });
          }
        } catch (error) {
          if (!navigator.onLine || error instanceof TypeError) await queueOfflineMutation(mutation);
          else if (error instanceof ApiError && error.status === 409 && error.payload.current) {
            const currentQuote = error.payload.current as NonInventoryRecord;
            setQuotes((current) => [currentQuote, ...current.filter((item) => item.id !== optimisticId && item.id !== currentQuote.id)]);
            setCalculatorForm(quoteToForm(currentQuote));
            navigateTab("calculator");
            notify({ type: "warning", text: `${error.message} Se abrió la versión más reciente para que la revisés.` });
          }
          else {
            setQuotes((current) => existingQuote
              ? [existingQuote, ...current.filter((item) => item.id !== optimisticId && item.id !== existingQuote.id)]
              : current.filter((item) => item.id !== optimisticId));
            notify({ type: "error", text: error instanceof Error ? error.message : `No se pudo guardar ${submittedForm.name}.`, sticky: true });
          }
        }
      })();
      return;
    }

    const optimisticId = existing?.id ?? nextTemporaryProductId.current--;
    const stillNeedsRestock = (submittedForm.minimumStockEnabled && quantityAvailable <= minimumStock) || quantityAvailable === 0;
    const optimistic: ProductRecord = {
      id: optimisticId,
      name: submittedForm.name,
      code: submittedForm.code || null,
      purchasePriceUsd: price,
      weightLb: weight,
      quantityAvailable,
      minimumStock,
      minimumStockEnabled: submittedForm.minimumStockEnabled,
      restockPurchasedAt: stillNeedsRestock ? existing?.restockPurchasedAt ?? null : null,
      zeroStockSince: quantityAvailable === 0 ? existing?.zeroStockSince ?? now : null,
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    setProducts((current) => [optimistic, ...current.filter((product) => product.id !== optimistic.id)]);
    clearForm();
    notify({ type: "success", text: "Producto agregado." });

    const id = mutationId();
    const base = existing ? {
      name: existing.name,
      code: existing.code || "",
      purchasePriceUsd: existing.purchasePriceUsd,
      weightLb: existing.weightLb,
      quantityAvailable: existing.quantityAvailable,
      minimumStock: existing.minimumStock,
      minimumStockEnabled: existing.minimumStockEnabled,
    } : undefined;
    const mutation: QueuedMutation = {
      id,
      method: existing ? "PUT" : "POST",
      url: existing ? `/api/products/${existing.id}` : "/api/products",
      body: { ...submittedForm, purchasePriceUsd: price, weightLb: weight, quantityAvailable, minimumStock, minimumStockEnabled: submittedForm.minimumStockEnabled, version: existing?.version, base },
      tempId: optimisticId,
      createdAt: now,
    };

    void (async () => {
      if (!navigator.onLine) return queueOfflineMutation(mutation);
      try {
        const data = await json<{ product: ProductRecord | null; deleted?: boolean; skippedFields?: string[] }>(await fetch(mutation.url, {
        method: mutation.method,
        headers: { "Content-Type": "application/json", "X-Mutation-Id": id },
        body: JSON.stringify({ ...mutation.body, mutationId: id }),
        keepalive: true,
      }));
        if (!data.product) {
          setProducts((current) => current.filter((product) => product.id !== optimisticId));
          notify({ type: "warning", text: "El producto fue eliminado por otra persona mientras lo editabas; no se volvió a crear." });
          return;
        }
        setProducts((current) => [data.product!, ...current.filter((product) => product.id !== optimisticId && product.id !== data.product!.id)]);
        if (data.skippedFields?.length) notify({ type: "warning", text: "Otra persona cambió algunos datos al mismo tiempo. Se conservaron esos valores más recientes; revisá el producto.", dismissOnPageTouch: false, durationMs: 5000 });
      } catch (error) {
        if (!navigator.onLine || error instanceof TypeError) {
          await queueOfflineMutation(mutation);
          return;
        }
        if (error instanceof ApiError && error.status === 409 && error.payload.current) {
          const current = error.payload.current as ProductRecord;
          setProducts((items) => [current, ...items.filter((item) => item.id !== optimisticId && item.id !== current.id)]);
          setProductForm({ ...submittedForm, id: current.id, addToInventory: true });
          setProductEditorOpen(true);
          navigateTab("products");
          notify({ type: "warning", text: `${error.message} Tus datos quedaron abiertos para revisarlos y volver a guardar.`, dismissOnPageTouch: false, durationMs: 6000 });
          return;
        }
        setProducts((current) => existing
          ? [existing, ...current.filter((product) => product.id !== optimisticId && product.id !== existing.id)]
          : current.filter((product) => product.id !== optimisticId));
        notify({ type: "error", text: error instanceof Error ? `${submittedForm.name}: ${error.message}` : `No se pudo guardar ${submittedForm.name}.`, sticky: true });
      }
    })();
  }

  function saveQuantities() {
    const parsed = parseQuantityText(quantityText);
    if (!parsed.entries.length) {
      notify({ type: "error", text: parsed.invalidLines.length ? `Revisá la${parsed.invalidLines.length === 1 ? " línea" : "s líneas"} ${parsed.invalidLines.join(", ")}. Usá el formato CÓDIGO: CANTIDAD.` : "Agregá al menos un código y su cantidad." });
      return;
    }
    const values = new Map(parsed.entries.map((entry) => [normalizeCode(entry.code), entry.quantityAdded]));
    const now = new Date().toISOString();
    setProducts((items) => items.map((product) => {
      const quantityAdded = values.get(normalizeCode(product.code));
      if (quantityAdded === undefined) return product;
      const nextQuantity = product.quantityAvailable + quantityAdded;
      const aboveMinimum = nextQuantity > 0 && (!product.minimumStockEnabled || nextQuantity > product.minimumStock);
      return {
        ...product,
        quantityAvailable: nextQuantity,
        zeroStockSince: nextQuantity === 0 ? product.zeroStockSince || now : null,
        restockPurchasedAt: aboveMinimum ? null : product.restockPurchasedAt,
        version: product.version + 1,
        updatedAt: now,
      };
    }));
    setQuantityText("");
    const id = mutationId();
    const mutation: QueuedMutation = {
      id,
      method: "POST",
      url: "/api/products/quantities",
      body: { entries: parsed.entries },
      createdAt: now,
    };
    if (!navigator.onLine) {
      void queueOfflineMutation(mutation);
      notify({ type: "warning", text: `${parsed.entries.length} cantidad${parsed.entries.length === 1 ? " quedó guardada" : "es quedaron guardadas"} sin conexión y se sincronizarán al volver Internet.` });
      return;
    }
    notify({ type: "success", text: `Actualizando ${parsed.entries.length} cantidad${parsed.entries.length === 1 ? "" : "es"} en segundo plano.` });
    void (async () => {
      try {
        const data = await json<{ products: ProductRecord[]; updated: number; addedTotal: number; notFound: string[]; invalid: number[] }>(await fetch(mutation.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Mutation-Id": id },
          body: JSON.stringify({ ...mutation.body, mutationId: id }),
          keepalive: true,
        }));
        const updatedIds = new Set(data.products.map((product) => product.id));
        setProducts((items) => [...data.products, ...items.filter((item) => !updatedIds.has(item.id))]);
        if (data.notFound.length || parsed.invalidLines.length) {
          const parts = [];
          if (data.notFound.length) parts.push(`${data.notFound.length} código${data.notFound.length === 1 ? " no existe" : "s no existen"}: ${data.notFound.slice(0, 5).join(", ")}`);
          if (parsed.invalidLines.length) parts.push(`líneas inválidas: ${parsed.invalidLines.join(", ")}`);
          notify({ type: "warning", text: `${data.addedTotal} unidades agregadas. ${parts.join(" · ")}.` });
        } else {
          notify({ type: "success", text: `${data.addedTotal} unidad${data.addedTotal === 1 ? " agregada" : "es agregadas"} al inventario.` });
        }
      } catch (error) {
        if (!navigator.onLine || error instanceof TypeError) {
          await queueOfflineMutation(mutation);
          notify({ type: "warning", text: "Las cantidades quedaron guardadas sin conexión y se sincronizarán al volver Internet." });
        } else {
          await refreshProducts().catch(() => undefined);
          notify({ type: "error", text: error instanceof Error ? error.message : "No se pudieron actualizar las cantidades." });
        }
      }
    })();
  }

  async function removeSelectedProducts() {
    const allIds = [...selectedProductIds];
    const ids = allIds.filter((id) => id > 0);
    const temporaryIds = allIds.filter((id) => id < 0);
    if (!allIds.length) {
      setBulkDeleteConfirm(false);
      notify({ type: "error", text: "Seleccioná al menos un producto." });
      return;
    }
    if (isOnline && temporaryIds.length) {
      setBulkDeleteConfirm(false);
      notify({ type: "warning", text: "Esperá un momento a que terminen de guardarse los productos nuevos antes de eliminarlos en grupo." });
      return;
    }
    const names = products.filter((product) => allIds.includes(product.id)).map((product) => product.name);
    setBulkDeleting(true);
    setBulkDeleteConfirm(false);
    setProducts((items) => items.filter((product) => !allIds.includes(product.id)));
    setSelectedProductIds(new Set());
    setSelectionMode(false);
    const id = mutationId();
    const mutation: QueuedMutation = { id, method: "POST", url: "/api/products/bulk-delete", body: { ids }, createdAt: new Date().toISOString() };
    if (!navigator.onLine) {
      if (ids.length) await queueOfflineMutation(mutation);
      for (const temporaryId of temporaryIds) {
        await queueOfflineMutation({
          id: mutationId(),
          method: "DELETE",
          url: `/api/products/${temporaryId}`,
          createdAt: new Date().toISOString(),
        });
      }
      setBulkDeleting(false);
      notify({ type: "success", text: `${allIds.length} producto${allIds.length === 1 ? " fue eliminado" : "s fueron eliminados"}. El cambio se sincronizará al volver Internet.` });
      return;
    }
    notify({ type: "success", text: `Eliminando ${ids.length} producto${ids.length === 1 ? "" : "s"} en segundo plano.` });
    void (async () => {
      try {
        const data = await json<{ deleted: number; deletedIds: number[]; alreadyDeleted: number[] }>(await fetch(mutation.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Mutation-Id": id },
          body: JSON.stringify({ ids, mutationId: id }),
          keepalive: true,
        }));
        notify({ type: "success", text: `${ids.length} producto${ids.length === 1 ? " fue eliminado" : "s fueron eliminados"}${data.alreadyDeleted.length ? "; algunos ya habían sido eliminados por otra persona" : ""}.` });
      } catch (error) {
        if (!navigator.onLine || error instanceof TypeError) {
          await queueOfflineMutation(mutation);
          notify({ type: "success", text: `${ids.length} producto${ids.length === 1 ? " fue eliminado" : "s fueron eliminados"}. El cambio se sincronizará al volver Internet.` });
        } else {
          await refreshProducts().catch(() => undefined);
          notify({ type: "error", text: error instanceof Error ? error.message : `No se pudieron eliminar ${names.length} productos.` });
        }
      } finally { setBulkDeleting(false); }
    })();
  }

  async function removeProduct() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleting(true);
    setProducts((current) => current.filter((product) => product.id !== target.id));
    if (productForm.id === target.id) clearProductForm();
    setDeleteTarget(null);
    const id = mutationId();
    const mutation: QueuedMutation = { id, method: "DELETE", url: `/api/products/${target.id}`, headers: { "If-Match": String(target.version) }, createdAt: new Date().toISOString() };
    if (!navigator.onLine) {
      await queueOfflineMutation(mutation);
      notify({ type: "success", text: `${target.name} fue eliminado.` });
      setDeleting(false);
      return;
    }
    try {
      await json<{ deleted: boolean }>(await fetch(mutation.url, { method: "DELETE", headers: { "X-Mutation-Id": id, "If-Match": String(target.version) } }));
      notify({ type: "success", text: `${target.name} fue eliminado.` });
    } catch (error) {
      if (!navigator.onLine || error instanceof TypeError) {
        await queueOfflineMutation(mutation);
        notify({ type: "success", text: `${target.name} fue eliminado.` });
      } else {
        setProducts((current) => [target, ...current.filter((product) => product.id !== target.id)]);
        notify({ type: "error", text: error instanceof Error ? error.message : "No se pudo eliminar el producto." });
      }
    } finally {
      setDeleting(false);
    }
  }

  async function downloadInventory(format: ExportFormat) {
    if (!products.length && !quotes.length) {
      setExportConfirm(false);
      notify({ type: "error", text: "Todavía no hay productos para descargar." });
      return;
    }
    setExporting(true);
    try {
      const { exportInventoryFiles } = await import("@/lib/export-inventory");
      const result = await exportInventoryFiles(products, quotes, settings, format);
      setExportConfirm(false);
      const label = format === "both" ? "Excel y PDF descargados por separado" : format === "excel" ? "Excel descargado" : "PDF descargado";
      notify({ type: "success", text: `${label}: ${result.complete} completos, ${result.incomplete} incompletos y ${result.noInventory} en No inventario.` });
    } catch (error) {
      setExportConfirm(false);
      notify({ type: "error", text: error instanceof Error ? error.message : "No se pudieron generar las descargas." });
    } finally {
      setExporting(false);
    }
  }

  async function saveSettings(next: PricingSettings) {
    const id = mutationId();
    const mutation: QueuedMutation = { id, method: "PUT", url: "/api/settings", body: next as unknown as Record<string, unknown>, createdAt: new Date().toISOString() };
    if (!navigator.onLine) {
      setSettings(next);
      await queueOfflineMutation(mutation);
      notify({ type: "warning", text: "Ajustes guardados sin conexión. Los precios se verificarán al volver Internet.", dismissOnPageTouch: false, durationMs: 5000 });
      return;
    }
    try {
      const data = await json<{ settings: PricingSettings; verification: { inventory: number; noInventory: number; total: number; failed: Array<{ source: string; id: number; name: string }> } }>(await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json", "X-Mutation-Id": id }, body: JSON.stringify(next) }));
      setSettings(data.settings);
      if (data.verification.failed.length) {
        notify({ type: "error", text: `Ajustes guardados, pero ${data.verification.failed.length} producto${data.verification.failed.length === 1 ? " no pudo" : "s no pudieron"} recalcularse.`, sticky: true });
      } else {
        notify({ type: "success", text: `Ajustes guardados. Se verificaron ${data.verification.inventory} precios de Inventario y ${data.verification.noInventory} de No inventario.` });
      }
    } catch (error) {
      if (!navigator.onLine || error instanceof TypeError) {
        setSettings(next);
        await queueOfflineMutation(mutation);
        notify({ type: "warning", text: "Ajustes guardados sin conexión. Los precios se verificarán al volver Internet.", dismissOnPageTouch: false, durationMs: 5000 });
        return;
      }
      notify({ type: "error", text: error instanceof Error ? error.message : "No se pudieron guardar." });
      throw error;
    }
  }

  const nav: Array<[Tab, string, typeof Calculator]> = [["calculator", "Calcular", Calculator], ["orders", "Pedidos", Truck], ["products", "Productos", PackageSearch], ["import", "Importar", FileSpreadsheet], ["settings", "Ajustes", Settings]];
  if (loading) return <main className="loading"><Image className="loading-logo" src="/nutriplus-logo.jpg" alt="NutriPlus Supplements" width={94} height={94} priority /><Loader2 className="spin" />Preparando NutriPlus…</main>;

  return <main className="app-shell">
    <NotificationCenter />
    {(!isOnline || pendingSyncCount > 0) && <div className={`sync-status ${isOnline ? "syncing" : "offline"}`}>{isOnline ? <Cloud /> : <WifiOff />}<span>{isOnline ? syncing ? "Sincronizando cambios…" : `${pendingSyncCount} cambio${pendingSyncCount === 1 ? "" : "s"} por sincronizar` : `Sin conexión · ${pendingSyncCount ? `${pendingSyncCount} cambio${pendingSyncCount === 1 ? " guardado" : "s guardados"}` : "podés seguir trabajando"}`}</span></div>}
    {showPriceBar && <StickyPrices price={validPrice ? price : null} weight={validWeight ? weight : null} settings={settings} />}
    <div className="body"><aside className={`side ${showPriceBar ? "under-price" : ""}`}><span>Menú</span>{nav.map(([id, label, Icon]) => <a href={`/?tab=${id}`} className={tab === id ? "active" : ""} onClick={(event) => { event.preventDefault(); navigateTab(id); }} key={id}><Icon />{label}</a>)}<div className="weight-note"><Weight /><span><b>+{settings.extraWeightLb.toFixed(2)} lb</b><small>en cada cálculo</small></span></div></aside><div className="content">
      {tab === "calculator" && <div className="view calculator-view"><header className="compact-head"><div><span className="eyebrow">Cotización rápida</span><h1>{calculatorForm.source === "no_inventory" ? "Actualizar cotización" : calculatorForm.id ? "Actualizar producto" : "Calcular precio"}</h1></div><button className="btn ghost small" onClick={clearCalculatorForm}><RotateCcw />Limpiar</button></header><ProductForm form={calculatorForm} setForm={setCalculatorForm} settings={settings} suggestions={suggestions} suggestionsOpen={suggestionsOpen} setSuggestionsOpen={setSuggestionsOpen} onPick={fillCalculator} onExternalCode={(code) => void lookupCode(code, "calculator")} onOpenScanner={() => openScanner("lookup-calculator")} onImageCode={(file) => readCodeFromImage(file, "calculator")} onPasteCode={() => void pasteCode("calculator")} onSubmit={(event) => save(event, "calculator")} saving={false} activeNumeric={activeNumeric} setActiveNumeric={setActiveNumeric} /></div>}

      <div className="module-slot" hidden={tab !== "orders"}><OrdersView products={products} quotes={quotes} settings={settings} scannedBarcode={orderScannedBarcode} onConsumeScan={() => setOrderScannedBarcode(null)} onRequestScan={() => openScanner("orders")} onInventoryChanged={refreshProducts} onCatalogChanged={async () => { await Promise.all([refreshProducts(), refreshQuotes()]); }} /></div>

      {tab === "products" && <div className="view"><header className="view-head products-head"><div><span className="eyebrow">Historial guardado</span><h1>Productos</h1><p>Buscá, agregá o editá cualquier producto guardado.</p></div><button className={`restock-head-btn ${lowStockProducts.length ? "has-items" : ""}`} onClick={() => setRestockOpen(true)} aria-label={`Ver productos por abastecer: ${lowStockProducts.length}`}><BellRing /><span>Por abastecer</span><b>{lowStockProducts.length}</b></button></header>
        <div className="products-toolbar"><button className="btn primary" onClick={addInProducts}><Plus />Agregar producto</button><button className="btn secondary" onClick={() => setNoInventoryOpen(true)}><Package />No inventario ({quotes.length})</button><button className="btn secondary" onClick={() => void openRecent()}><Clock3 />Guardados recientemente</button><button className="btn secondary" onClick={() => setInventoryIntakeOpen(true)}><Upload />Agregar inventario</button><button className={`btn ${selectionMode ? "ghost" : "secondary"}`} onClick={() => { setSelectionMode((current) => !current); setSelectedProductIds(new Set()); }} disabled={!products.length}><Check />{selectionMode ? "Cancelar selección" : "Seleccionar varios"}</button>{selectionMode && selectedProductIds.size > 0 && <button className="btn danger-solid" onClick={() => setBulkDeleteConfirm(true)} disabled={bulkDeleting}><Trash2 />Eliminar ({selectedProductIds.size})</button>}<button className="btn secondary" onClick={() => setExportConfirm(true)} disabled={!products.length && !quotes.length}><Download />Descargar inventario</button></div>
        <section className={`surface stock-notification-strip ${lowStockProducts.length ? "has-alerts" : ""}`}><div className="stock-alert-heading"><span className="stock-alert-icon">{lowStockProducts.length ? <BellRing /> : <Bell />}</span><div><h2>{lowStockProducts.length ? `${pendingRestockProducts.length} pendiente${pendingRestockProducts.length === 1 ? "" : "s"} de compra · ${lowStockProducts.length - pendingRestockProducts.length} comprado${lowStockProducts.length - pendingRestockProducts.length === 1 ? "" : "s"}` : "Stock mínimo al día"}</h2><p>Las alertas se generan al cruzar el mínimo o llegar a cero, sin repetirse por cada cambio.</p></div></div><button className="btn secondary small" onClick={() => window.dispatchEvent(new Event("nutriplus:open-notifications"))}><Bell />Ver Centro de alertas</button></section>
        {productEditorOpen && <section className="editor-wrap"><div className="editor-heading"><div><span className="eyebrow">{productForm.id ? "Edición en Productos" : "Nuevo producto"}</span><h2>{productForm.id ? productForm.name : "Agregar producto al catálogo"}</h2></div><button className="icon-btn" onClick={clearProductForm} aria-label="Cerrar editor"><X /></button></div><ProductForm form={productForm} setForm={setProductForm} settings={settings} suggestions={[]} suggestionsOpen={false} setSuggestionsOpen={() => undefined} onPick={() => undefined} onExternalCode={productForm.id ? assignCode : (code) => void lookupCode(code, "products")} onOpenScanner={() => openScanner(productForm.id ? "assign" : "lookup-products")} onImageCode={(file) => readCodeFromImage(file, productForm.id ? "assign" : "products")} onPasteCode={() => void pasteCode(productForm.id ? "assign" : "products")} onSubmit={(event) => save(event, "products")} onCancel={clearProductForm} saving={false} activeNumeric={activeNumeric} setActiveNumeric={setActiveNumeric} showSuggestions={false} /></section>}
        <section className="surface search-card"><div className="input-icon grow"><Search /><input value={query} onChange={(event) => { setQuery(event.target.value); setVisibleCount(36); }} onKeyDown={(event) => detectScannerBurst(event, searchBurst, (code, before) => { setQuery(before); setVisibleCount(36); void lookupCode(code, "products"); })} placeholder="Ej. omega encargo o omega nordic" /></div><button className="scan-btn" onPointerDown={() => void preloadScanner()} onClick={() => openScanner("lookup-products")}><Camera /><span>Escanear</span></button></section>
        {!filteredProducts.length ? <Empty icon={<PackageSearch />} title={query ? "No hay coincidencias" : "Todavía no hay productos"} text={query ? "Probá con otras palabras o escaneá el código." : "Agregá el primer producto desde el botón superior."} /> : <><div className="results-count">{selectionMode ? `${selectedProductIds.size} seleccionado${selectedProductIds.size === 1 ? "" : "s"} · tocá las casillas de los productos` : query ? `${filteredProducts.length} coincidencias` : `${products.length} productos guardados`}</div><div className="product-grid">{filteredProducts.slice(0, visibleCount).map((product) => { const complete = hasCompletePricing(product); const prices = complete ? calculatePrices(product.purchasePriceUsd, product.weightLb, settings) : null; const lowStock = (product.minimumStockEnabled && product.quantityAvailable <= product.minimumStock) || product.quantityAvailable === 0; const selected = selectedProductIds.has(product.id); const pendingOnlineSave = product.id < 0 && isOnline; return <article className={`product-card ${complete ? "" : "pending-product"} ${lowStock ? "low-stock" : ""} ${selected ? "selected-product" : ""}`} key={product.id}><div className="product-title">{selectionMode && <label className="product-selector"><input type="checkbox" checked={selected} disabled={pendingOnlineSave} onChange={() => setSelectedProductIds((current) => { const next = new Set(current); if (next.has(product.id)) next.delete(product.id); else next.add(product.id); return next; })} aria-label={`Seleccionar ${product.name}`} /><span><Check /></span></label>}<span className="avatar">{product.name[0].toUpperCase()}</span><div><h2>{product.name}</h2>{product.code && <small><ScanLine />{product.code}</small>}{!complete && <small className="pending-label"><AlertCircle />Incompleto</small>}{lowStock && <small className="stock-label"><AlertCircle />{product.quantityAvailable === 0 ? "Stock 0" : "Stock bajo"}</small>}</div><div className="card-actions"><button className="icon-btn" onClick={() => editInProducts(product)} aria-label={`Editar ${product.name}`} disabled={pendingOnlineSave}><Pencil /></button><button className="icon-btn danger" onClick={() => setDeleteTarget(product)} aria-label={`Eliminar ${product.name}`} disabled={pendingOnlineSave}><Trash2 /></button></div></div><div className="facts"><div><span>Compra</span><b>{product.purchasePriceUsd === null ? "—" : usd(product.purchasePriceUsd)}</b></div><div><span>Peso</span><b>{product.weightLb === null ? "—" : `${product.weightLb.toFixed(2)} lb`}</b></div><div className="green"><span>Venta GAM</span><b>{prices ? crc(prices.gamPriceCrc) : "Incompleto"}</b></div><div className="brown"><span>Venta Puerto</span><b>{prices ? crc(prices.puertoPriceCrc) : "Incompleto"}</b></div><div className="stock"><span>Cantidad disponible</span><b>{product.quantityAvailable}</b></div><div className="stock"><span>Stock mínimo</span><b>{product.minimumStockEnabled ? product.minimumStock : "No configurado"}</b></div></div></article>; })}</div>{visibleCount < filteredProducts.length && <button className="btn secondary load-more" onClick={() => setVisibleCount((current) => current + 36)}>Mostrar más productos</button>}</>}
      </div>}

      <div className="module-slot" hidden={tab !== "import"}><ImportView key={importJob?.id ?? "sin-importacion"} settings={settings} job={importJob} deletionJob={deletionJob} productCount={products.filter((product) => product.id > 0).length} history={importHistory} summary={importSummary} restoringId={restoringImportId} onStart={startImport} onRestore={restoreImport} onDeleteAll={startDeletion} /></div>
      <div className="module-slot" hidden={tab !== "settings"}><SettingsView key={JSON.stringify(settings)} current={settings} onSave={saveSettings} /></div>
    </div></div>
    <nav className="bottom" aria-label="Navegación principal">{nav.map(([id, label, Icon]) => <a href={`/?tab=${id}`} className={tab === id ? "active" : ""} aria-current={tab === id ? "page" : undefined} onClick={(event) => { event.preventDefault(); navigateTab(id); }} key={id}><Icon />{label}</a>)}</nav><span className="app-version" aria-label={`Versión pública ${NUTRIPLUS_PUBLIC_VERSION}`}>NutriPlus v{NUTRIPLUS_PUBLIC_VERSION}</span><button className="float-scan" onPointerDown={() => void preloadScanner()} onClick={() => openScanner("floating")} aria-label="Escanear"><ScanLine /></button>
    {scannerIntent && <Scanner onClose={() => setScannerIntent(null)} onCode={handleScannerCode} />}
    {restockOpen && <div className="modal" role="dialog" aria-modal="true" aria-label="Productos por abastecer" onPointerDown={() => setRestockOpen(false)}><div className="restock-card" onPointerDown={(event) => event.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">Lista de compra</span><h2>Productos por abastecer</h2><p>Incluye los productos en el mínimo y cualquiera que haya llegado a stock 0.</p></div><button className="icon-btn" onClick={() => setRestockOpen(false)} aria-label="Cerrar lista"><X /></button></div>{lowStockProducts.length ? <div className="restock-list">{lowStockProducts.map((product) => <article className={`${product.restockPurchasedAt ? "purchased" : "pending-purchase"} ${product.quantityAvailable === 0 ? "zero-stock" : ""}`} key={product.id}><div><b>{product.name}</b>{product.code && <small>{product.code}</small>}<small className="purchase-status">{product.restockPurchasedAt ? "Comprado" : "Pendiente de compra"}{product.quantityAvailable === 0 ? " · Stock 0" : ""}</small></div><span><small>Disponible</small><b>{product.quantityAvailable}</b></span><span><small>Mínimo</small><b>{product.minimumStockEnabled ? product.minimumStock : "-"}</b></span><div className="restock-actions"><button className={`btn small ${product.restockPurchasedAt ? "secondary" : "primary"}`} onClick={() => void markRestock(product, !product.restockPurchasedAt)}>{product.restockPurchasedAt ? <RotateCcw /> : <Check />}{product.restockPurchasedAt ? "Marcar pendiente" : "Comprado"}</button><button className="btn ghost small" onClick={() => editInProducts(product)}><Pencil />Actualizar</button></div></article>)}</div> : <div className="restock-empty"><Check /><h3>Todo abastecido</h3><p>No hay productos por debajo del mínimo ni con stock 0.</p></div>}</div></div>}
    {noInventoryOpen && <div className="modal" role="dialog" aria-modal="true" aria-label="Productos de No inventario" onPointerDown={() => setNoInventoryOpen(false)}><div className="restock-card recent-card no-inventory-card" onPointerDown={(event) => event.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">Cotizaciones separadas</span><h2>No inventario</h2><p>{quotes.length} producto{quotes.length === 1 ? "" : "s"} que no {quotes.length === 1 ? "aparece" : "aparecen"} en el catálogo principal.</p></div><button className="icon-btn" onClick={() => setNoInventoryOpen(false)} aria-label="Cerrar No inventario"><X /></button></div><div className="surface search-card no-inventory-search"><div className="input-icon grow"><Search /><input value={noInventoryQuery} onChange={(event) => setNoInventoryQuery(event.target.value)} placeholder="Buscar por nombre o código" /></div></div>{filteredNoInventory.length ? <div className="recent-list no-inventory-list">{filteredNoInventory.map((item) => { const prices = hasCompletePricing(item) ? calculatePrices(item.purchasePriceUsd, item.weightLb, settings) : null; return <article key={item.id}><div><b>{item.name}</b><small>{item.code || "Sin código"} · {importDate(item.updatedAt)}</small></div><span className="source-pill no_inventory">No inventario</span><span><small>GAM</small><b>{prices ? crc(prices.gamPriceCrc) : "Incompleto"}</b></span><button className="btn ghost small" onClick={() => editNoInventory(item)}><Pencil />Editar</button></article>; })}</div> : <p className="empty-summary">{noInventoryQuery ? "No hay coincidencias." : "Todavía no hay productos en No inventario."}</p>}</div></div>}
    {recentOpen && <div className="modal" role="dialog" aria-modal="true" aria-label="Productos guardados recientemente" onPointerDown={() => setRecentOpen(false)}><div className="restock-card recent-card" onPointerDown={(event) => event.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">Actividad reciente</span><h2>Guardados recientemente</h2><p>Se identifica si cada registro pertenece al Inventario o a No inventario.</p></div><button className="icon-btn" onClick={() => setRecentOpen(false)} aria-label="Cerrar recientes"><X /></button></div>{recentLoading ? <div className="recent-loading"><Loader2 className="spin" />Cargando…</div> : <div className="recent-list">{recentItems.map(({ source, item }) => { const prices = hasCompletePricing(item) ? calculatePrices(item.purchasePriceUsd, item.weightLb, settings) : null; return <article key={`${source}-${item.id}`}><div><b>{item.name}</b><small>{item.code || "Sin código"} · {importDate(item.updatedAt)}</small></div><span className={`source-pill ${source}`}>{source === "inventory" ? "Inventario" : "No inventario"}</span><span><small>GAM</small><b>{prices ? crc(prices.gamPriceCrc) : "Incompleto"}</b></span><button className="btn ghost small" onClick={() => source === "inventory" ? editInProducts(item as ProductRecord) : editNoInventory(item as NonInventoryRecord)}><Pencil />Editar</button></article>; })}</div>}</div></div>}
    <InventoryIntakeModal
      open={inventoryIntakeOpen}
      products={products}
      quotes={quotes}
      quickText={quantityText}
      setQuickText={setQuantityText}
      onQuickSave={saveQuantities}
      onClose={() => setInventoryIntakeOpen(false)}
      onNotify={notify}
      onProductsChanged={(updated) => setProducts((current) => {
        const ids = new Set(updated.map((product) => product.id));
        return [...updated, ...current.filter((product) => !ids.has(product.id))];
      })}
      onRefresh={async () => { await Promise.all([refreshProducts(), refreshQuotes()]); }}
      onRequestScan={(lineId) => { setIntakeScanTarget(lineId); setScannerIntent("intake"); }}
      scannedBarcode={intakeScannedBarcode}
      onConsumeScan={() => setIntakeScannedBarcode(null)}
      readBarcodeImage={decodeBarcodeImage}
    />
    {exportConfirm && <div className="modal" role="dialog" aria-modal="true" aria-label="Elegir descarga del inventario"><div className="confirm-card export-card"><div className="download-symbol"><Download /></div><h2>Descargar inventario</h2><p>Incluye {products.length} productos del inventario y {quotes.length} de No inventario. El PDF también tendrá la sección No inventario.</p><div className="export-options"><button className={exportFormat === "pdf" ? "chosen" : ""} onClick={() => setExportFormat("pdf")}><b>PDF</b><small>Documento minimalista</small></button><button className={exportFormat === "excel" ? "chosen" : ""} onClick={() => setExportFormat("excel")}><b>Excel</b><small>Hojas editables</small></button><button className={exportFormat === "both" ? "chosen" : ""} onClick={() => setExportFormat("both")}><b>Ambos</b><small>Dos archivos separados</small></button></div><div className="confirm-actions"><button className="btn secondary" onClick={() => setExportConfirm(false)} disabled={exporting}>Cancelar</button><button className="btn primary" onClick={() => void downloadInventory(exportFormat)} disabled={exporting}>{exporting ? <Loader2 className="spin" /> : <Download />}Descargar</button></div></div></div>}
    {deleteTarget && <div className="modal" role="dialog" aria-modal="true" aria-label="Confirmar eliminación"><div className="confirm-card"><div className="delete-symbol"><Trash2 /></div><h2>¿Eliminar producto?</h2><p>Vas a eliminar <b>{deleteTarget.name}</b>. Esta acción no se puede deshacer.</p><div className="confirm-actions"><button className="btn secondary" onClick={() => setDeleteTarget(null)} disabled={deleting}>No, cancelar</button><button className="btn danger-solid" onClick={() => void removeProduct()} disabled={deleting}>{deleting ? <Loader2 className="spin" /> : <Trash2 />}Sí, eliminar</button></div></div></div>}
    {bulkDeleteConfirm && <div className="modal" role="dialog" aria-modal="true" aria-label="Confirmar eliminación de productos seleccionados"><div className="confirm-card"><div className="delete-symbol"><Trash2 /></div><h2>¿Eliminar {selectedProductIds.size} productos?</h2><p>Se eliminarán únicamente los productos seleccionados. Esta acción también puede completarse en segundo plano o sincronizarse al volver Internet.</p><div className="confirm-actions"><button className="btn secondary" onClick={() => setBulkDeleteConfirm(false)} disabled={bulkDeleting}>No, cancelar</button><button className="btn danger-solid" onClick={() => void removeSelectedProducts()} disabled={bulkDeleting}><Trash2 />Sí, eliminar seleccionados</button></div></div></div>}
    {exitConfirmOpen && <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="exit-confirm-title"><div className="confirm-card"><h2 id="exit-confirm-title">¿Quieres salir de NutriPlus?</h2><div className="confirm-actions"><button className="btn secondary" onClick={() => { navigation.current?.cancelExit(); setExitConfirmOpen(false); }}>Cancelar</button><button className="btn primary" onClick={() => { setExitConfirmOpen(false); navigation.current?.confirmExit(); }}>Salir</button></div></div></div>}
    {toast && <div className={`toast ${toast.type} ${toast.sticky ? "sticky" : ""}`} role={toast.type === "error" ? "alert" : "status"} aria-live={toast.type === "error" ? "assertive" : "polite"}>{toast.type === "success" ? <Check /> : <AlertCircle />}<span>{toast.title && <b>{toast.title}</b>}<small>{toast.text}</small></span><button onClick={() => setToast(null)} aria-label="Cerrar notificación"><X /></button></div>}
  </main>;
}
