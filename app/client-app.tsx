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
  Delete as DeleteKey,
  Download,
  FileSpreadsheet,
  Flashlight,
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
import type { ImportChangedProduct, ImportJobRecord } from "@/lib/import-jobs";
import {
  calculatePrices,
  crc,
  DEFAULT_SETTINGS,
  hasCompletePricing,
  normalizeName,
  type PricingSettings,
  type ProductRecord,
  searchProducts,
  usd,
} from "@/lib/pricing";

type Tab = "calculator" | "products" | "import" | "settings";
type NumericField = "purchasePriceUsd" | "weightLb";
type ScannerIntent = "assign" | "lookup-products" | "lookup-calculator";
type Form = {
  id: number | null;
  name: string;
  code: string;
  purchasePriceUsd: string;
  weightLb: string;
  quantityAvailable: string;
  minimumStock: string;
  minimumStockEnabled: boolean;
};
type Toast = { type: "success" | "error"; text: string; sticky?: boolean } | null;
type Mapping = {
  name: string;
  purchasePriceUsd: string;
  weightLb: string;
  code: string;
  quantityAvailable: string;
  minimumStock: string;
};
type BurstState = { text: string; startedAt: number; lastAt: number; valueBefore: string };

const EMPTY: Form = {
  id: null,
  name: "",
  code: "",
  purchasePriceUsd: "",
  weightLb: "0",
  quantityAvailable: "",
  minimumStock: "",
  minimumStockEnabled: false,
};
const EMPTY_BURST: BurstState = { text: "", startedAt: 0, lastAt: 0, valueBefore: "" };
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", ".", "backspace"] as const;

let scannerModulePromise: Promise<typeof import("@zxing/browser")> | null = null;
function preloadScanner() {
  scannerModulePromise ??= import("@zxing/browser");
  return scannerModulePromise;
}

type BarcodeResult = { rawValue: string; format?: string };
type BarcodeDetectorInstance = { detect: (source: HTMLVideoElement) => Promise<BarcodeResult[]> };
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
  if (!response.ok) throw new Error(body.error || "Ocurrió un error inesperado.");
  return body;
}

function productToForm(product: ProductRecord): Form {
  return {
    id: product.id,
    name: product.name,
    code: product.code || "",
    purchasePriceUsd: product.purchasePriceUsd === null ? "" : String(product.purchasePriceUsd),
    weightLb: product.weightLb === null ? "" : String(product.weightLb),
    quantityAvailable: String(product.quantityAvailable),
    minimumStock: String(product.minimumStock),
    minimumStockEnabled: product.minimumStockEnabled,
  };
}

function normalizeCode(value: string | null | undefined) {
  return (value || "").trim().toLowerCase().replace(/\s+/g, "");
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

  return <div className="modal" role="dialog" aria-modal="true" aria-label="Escáner de producto" onPointerDown={onClose}><div className="scanner-card" onPointerDown={(event) => event.stopPropagation()}>
    <div className="modal-head"><div><span className="eyebrow">Cámara</span><h2>Escanear producto</h2></div><button className="icon-btn" onClick={onClose} aria-label="Cerrar"><X /></button></div>
    <div className="camera" onPointerDown={onClose}><video ref={video} muted playsInline /><canvas ref={canvas} hidden /><div className="scan-frame" />{starting && <div className="camera-state"><Loader2 className="spin" />Abriendo cámara…</div>}</div>
    {error ? <p className="alert error"><AlertCircle size={17} />{error}</p> : <div className="scanner-help"><p className="hint">Colocá el QR o código de barras dentro del recuadro.</p>{torchAvailable && <button className={`torch-btn ${torchOn ? "active" : ""}`} onClick={() => { autoTorchEnabledRef.current = false; void applyTorch(!torchOn); }}><Flashlight />{torchOn ? "Apagar linterna" : "Encender linterna"}</button>}</div>}
    {torchAvailable && <p className="auto-light">La linterna se activa automáticamente si detecta poca luz. Tocá la cámara o el fondo para cerrarla.</p>}
    <button className="btn secondary full" onClick={onClose}>Cancelar</button>
  </div></div>;
}

function StickyPrices({ price, weight, settings }: { price: number | null; weight: number | null; settings: PricingSettings }) {
  const [open, setOpen] = useState(false);
  const complete = price !== null && Number.isFinite(price) && price >= 0 && weight !== null && Number.isFinite(weight) && weight >= 0;
  const result = complete ? calculatePrices(price, weight, settings) : null;
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", close);
    window.addEventListener("scroll", close, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", close);
    };
  }, [open]);
  return <header className="price-bar"><div className="price-bar-inner">
    <div className="sticky-price gam"><MapPin /><span>GAM</span><strong>{result ? crc(result.gamPriceCrc) : "—"}</strong></div>
    <div className="sticky-price port"><Truck /><span>Puerto</span><strong>{result ? crc(result.puertoPriceCrc) : "—"}</strong></div>
    <details className="sticky-details" open={open}><summary onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.preventDefault(); setOpen((current) => !current); }}>Ver desglose <ChevronDown /></summary><div className="sticky-breakdown">
      {result ? <div className="breakdown">
        <div><span>Peso ingresado</span><b>{weight?.toFixed(2)} lb</b></div><div><span>Peso cobrado (+{settings.extraWeightLb.toFixed(2)})</span><b>{result.chargedWeightLb.toFixed(2)} lb</b></div>
        <div><span>Courier</span><b>{usd(result.courierUsd)}</b></div><div><span>Compra + courier</span><b>{usd(result.merchandiseAndCourierUsd)}</b></div>
        <div><span>Entrega + Correos</span><b>{crc(settings.deliveryCrc + settings.correosCrc)}</b></div><div className="total"><span>Precio costo</span><b>{crc(result.costCrc)}</b></div>
      </div> : <p className="pending-note"><AlertCircle />Ingresá el precio de compra y el peso para ver el desglose.</p>}
    </div></details>
  </div></header>;
}

function NumericKeypad({ active, onKey, onClose }: { active: NumericField; onKey: (key: typeof KEYS[number]) => void; onClose: () => void }) {
  const label = active === "purchasePriceUsd" ? "precio" : "peso";
  return <div className="numeric-keypad" aria-label="Teclado numérico"><div className="keypad-head"><span>Ingresando {label}</span><button type="button" onClick={onClose} aria-label="Ocultar teclado"><X /></button></div><div className="keypad-grid">
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
  onSubmit,
  onCancel,
  saving,
  activeNumeric,
  setActiveNumeric,
  showSuggestions = true,
}: ProductFormProps) {
  const nameBurst = useRef<BurstState>({ ...EMPTY_BURST });
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
      else if (key === ".") next = existing.includes(".") ? existing : `${existing || "0"}.`;
      else if (existing.length < 10) next = existing === "0" ? key : `${existing}${key}`;
      return { ...current, [activeNumeric]: next };
    });
  }

  return <form className="surface form-card" onSubmit={onSubmit}>{form.id && <div className="edit-banner"><Pencil />Editando producto guardado</div>}
    <label className="field name-field"><span>Nombre del producto <em>*</em></span><div className="input-icon"><Package /><input value={form.name} onChange={(event) => { setForm({ ...form, name: event.target.value }); setSuggestionsOpen(true); }} onKeyDown={(event) => detectScannerBurst(event, nameBurst, (code, before) => { setForm((current) => ({ ...current, name: before, code })); onExternalCode(code); })} onFocus={() => setSuggestionsOpen(true)} onBlur={() => window.setTimeout(() => setSuggestionsOpen(false), 160)} placeholder="Ej. Omega 3 Nordic encargo" required /></div>{showSuggestions && suggestionsOpen && form.name.trim() && suggestions.length > 0 && <div className="suggestions"><small>Productos encontrados</small>{suggestions.slice(0, 7).map((product) => <button type="button" onMouseDown={() => onPick(product)} key={product.id}><b>{product.name}</b><span>{product.purchasePriceUsd === null ? "Compra incompleta" : usd(product.purchasePriceUsd)} · {product.weightLb === null ? "peso incompleto" : `${product.weightLb.toFixed(2)} lb`}</span></button>)}</div>}<p className="hint">Podés buscar con varias palabras aunque no estén seguidas.</p></label>
    <label className="field"><span>Código QR o de barras <small>Opcional</small></span><div className="code-row"><div className="input-icon grow"><ScanLine /><input value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); const code = event.currentTarget.value.trim(); if (code) setForm((current) => ({ ...current, code })); } }} placeholder="Escaneá o escribí el código" autoComplete="off" /></div><button type="button" className="scan-btn" onPointerDown={() => void preloadScanner()} onClick={onOpenScanner}><Camera /><span>Escanear</span></button></div></label>
    <div className="two"><label className="field"><span>Precio de compra</span><div className={`number-box tappable ${activeNumeric === "purchasePriceUsd" ? "active" : ""}`}><i>$</i><input type="text" inputMode="none" readOnly value={form.purchasePriceUsd} onFocus={() => setActiveNumeric("purchasePriceUsd")} onClick={() => setActiveNumeric("purchasePriceUsd")} placeholder="Incompleto" /></div><p className="hint">En dólares</p></label><label className="field"><span>Peso</span><div className={`number-box tappable ${activeNumeric === "weightLb" ? "active" : ""}`}><input type="text" inputMode="none" readOnly value={form.weightLb} onFocus={() => setActiveNumeric("weightLb")} onClick={() => setActiveNumeric("weightLb")} placeholder="Incompleto" /><small>lb</small></div><p className="hint">Se suman {settings.extraWeightLb.toFixed(2)} lb.</p></label></div>
    <div className="inventory-fields"><label className="field"><span>Cantidad disponible</span><div className="stock-stepper"><button type="button" onClick={() => setForm((current) => ({ ...current, quantityAvailable: String(Math.max(0, Number(current.quantityAvailable || 0) - 1)) }))} aria-label="Restar una unidad"><Minus /></button><input type="text" inputMode="numeric" value={form.quantityAvailable} onChange={(event) => setForm({ ...form, quantityAvailable: event.target.value.replace(/\D/g, "").slice(0, 7) })} placeholder="0" aria-label="Cantidad disponible" /><button type="button" onClick={() => setForm((current) => ({ ...current, quantityAvailable: String(Number(current.quantityAvailable || 0) + 1) }))} aria-label="Sumar una unidad"><Plus /></button></div></label>
      <label className={`stock-toggle ${form.minimumStockEnabled ? "enabled" : ""}`}><input type="checkbox" checked={form.minimumStockEnabled} onChange={(event) => setForm((current) => ({ ...current, minimumStockEnabled: event.target.checked, minimumStock: event.target.checked ? (current.minimumStock || "0") : "" }))} /><span><b>Controlar stock mínimo</b><small>Activá esta alerta solo para los productos más vendidos.</small></span></label>
      {form.minimumStockEnabled && <label className="field minimum-stock-field"><span>Cantidad para activar la alerta</span><div className="stock-stepper"><button type="button" onClick={() => setForm((current) => ({ ...current, minimumStock: String(Math.max(0, Number(current.minimumStock || 0) - 1)) }))} aria-label="Restar una unidad al stock mínimo"><Minus /></button><input type="text" inputMode="numeric" value={form.minimumStock} onChange={(event) => setForm({ ...form, minimumStock: event.target.value.replace(/\D/g, "").slice(0, 7) })} placeholder="0" aria-label="Stock mínimo" /><button type="button" onClick={() => setForm((current) => ({ ...current, minimumStock: String(Number(current.minimumStock || 0) + 1) }))} aria-label="Sumar una unidad al stock mínimo"><Plus /></button></div><p className="hint">Se avisará cuando la cantidad llegue o baje de este número.</p></label>}
    </div>
    {activeNumeric && <NumericKeypad active={activeNumeric} onKey={keypad} onClose={() => setActiveNumeric(null)} />}
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
  history: ImportJobRecord[];
  summary: ImportChangedProduct[];
  restoringId: number | null;
  onStart: (payload: { rows: Array<Record<string, unknown>>; strategy: "update" | "skip"; fileName: string; sheetName: string }) => Promise<void>;
  onRestore: (job: ImportJobRecord) => Promise<void>;
};

function importDate(value: string) {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  return new Intl.DateTimeFormat("es-CR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(normalized));
}

function ImportView({ settings, job, history, summary, restoringId, onStart, onRestore }: ImportViewProps) {
  const input = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [sheetName, setSheetName] = useState("");
  const [firstDataRow, setFirstDataRow] = useState(2);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<unknown[][]>([]);
  const [mapping, setMapping] = useState<Mapping>({ name: "", purchasePriceUsd: "", weightLb: "", code: "", quantityAvailable: "", minimumStock: "" });
  const [strategy, setStrategy] = useState<"update" | "skip">("update");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Toast>(null);
  const [restoreTarget, setRestoreTarget] = useState<ImportJobRecord | null>(null);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const mapped = useMemo(() => rows.map((row, index) => {
    const codeCell = mapping.code === "" ? null : row[Number(mapping.code)];
    const quantityCell = mapping.quantityAvailable === "" ? null : row[Number(mapping.quantityAvailable)];
    const minimumCell = mapping.minimumStock === "" ? null : row[Number(mapping.minimumStock)];
    return {
      rowNumber: index + firstDataRow,
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
  }), [firstDataRow, mapping, rows]);
  const named = mapped.filter((row) => row.name);
  const ready = [...new Map(named.map((row) => [normalizeName(row.name), row])).values()];
  const duplicates = named.length - ready.length;
  const incomplete = ready.filter((row) => !row.hasPurchasePrice || row.purchasePriceUsd === null || !row.hasWeight || row.weightLb === null);
  const running = job?.status === "queued" || job?.status === "running";
  const percentage = job ? Math.min(100, Math.round((job.processedRows / Math.max(1, job.totalRows)) * 100)) : 0;

  useEffect(() => {
    if (!notice) return;
    const dismiss = () => setNotice(null);
    const timer = window.setTimeout(dismiss, 3800);
    document.addEventListener("pointerdown", dismiss, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", dismiss, true);
    };
  }, [notice]);

  async function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setNotice(null);
    try {
      const buffer = await file.arrayBuffer();
      const parsed = await new Promise<{ sheetName: string; headers: string[]; rows: unknown[][]; firstDataRow: number }>((resolve, reject) => {
        const parser = new Worker(new URL("../lib/import-worker.ts", import.meta.url), { type: "module" });
        parser.onmessage = (message: MessageEvent<{ ok: boolean; error?: string; sheetName: string; headers: string[]; rows: unknown[][]; firstDataRow: number }>) => {
          parser.terminate();
          if (message.data.ok) resolve(message.data);
          else reject(new Error(message.data.error || "No se pudo leer el archivo."));
        };
        parser.onerror = () => { parser.terminate(); reject(new Error("No se pudo leer el archivo.")); };
        parser.postMessage({ buffer }, [buffer]);
      });
      const normalized = parsed.headers.map(normalizeName);
      const find = (...tests: RegExp[]) => { const index = normalized.findIndex((head) => tests.some((test) => test.test(head))); return index < 0 ? "" : String(index); };
      setFileName(file.name);
      setSheetName(parsed.sheetName);
      setFirstDataRow(parsed.firstDataRow);
      setHeaders(parsed.headers);
      setRows(parsed.rows);
      setMapping({
        name: find(/^producto$/, /nombre/, /descripcion/),
        purchasePriceUsd: find(/precio.*compra/, /precio.*producto/, /costo.*usd/, /^precio$/),
        weightLb: find(/^libras$/, /peso.*lb/, /^peso$/, /^lb$/),
        code: find(/codigo/, /barra/, /barcode/, /^qr$/),
        quantityAvailable: find(/^cant$/, /cantidad.*disponible/, /existencia/, /stock.*actual/),
        minimumStock: find(/stock.*minimo/, /cantidad.*minima/, /^minimo$/),
      });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "No se pudo leer el archivo." });
    } finally {
      setBusy(false);
      event.target.value = "";
    }
  }

  const reset = () => { setHeaders([]); setRows([]); setFileName(""); setSheetName(""); setNotice(null); };

  async function beginImport() {
    setBusy(true);
    setNotice(null);
    setSummaryExpanded(false);
    try {
      await onStart({ rows: ready, strategy, fileName, sheetName });
      reset();
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "No se pudo iniciar la importación." });
    } finally {
      setBusy(false);
    }
  }

  return <div className="view"><header className="view-head"><span className="eyebrow">Carga masiva segura</span><h1>Importar Excel</h1><p>La importación continúa aunque cambiés de sección y crea un respaldo antes de empezar.</p></header>
    {job && <section className={`surface import-progress ${job.status}`}><div className="progress-head"><div><span className="eyebrow">{running ? "Importando en segundo plano" : job.status === "completed" ? "Importación completada" : "La importación encontró un problema"}</span><h2>{job.fileName}</h2><p>{job.sheetName ? `Hoja ${job.sheetName} · ` : ""}{job.processedRows} de {job.totalRows} productos procesados</p></div><strong>{job.status === "completed" ? "100%" : `${percentage}%`}</strong></div><div className="progress-track" aria-label={`${percentage}% importado`}><span style={{ width: `${job.status === "completed" ? 100 : percentage}%` }} /></div><div className="progress-stats"><span><b>{job.importedCount}</b>Nuevos</span><span><b>{job.updatedCount}</b>Actualizados</span><span><b>{job.skippedCount}</b>Omitidos</span><span><b>{job.conflictCount + job.errorCount}</b>Sin cambiar</span></div>{running && <p className="background-note"><Loader2 className="spin" />Podés seguir usando Calcular, Productos o Ajustes. Guardar un producto manualmente no detiene ni sobrescribe tu cambio.</p>}</section>}

    {!running && (!headers.length ? <section className="surface upload"><div className="upload-icon"><FileSpreadsheet /></div><h2>{busy ? "Leyendo archivo en segundo plano…" : "Seleccioná tu archivo"}</h2><p>.xlsx, .xlsm, .xls o .csv</p><label className={`btn primary ${busy ? "disabled" : ""}`} htmlFor="nutriplus-import-file">{busy ? <Loader2 className="spin" /> : <Upload />}Elegir archivo</label><input id="nutriplus-import-file" className="native-file-input" ref={input} type="file" accept=".xlsx,.xlsm,.xls,.csv" onChange={pick} disabled={busy} /></section> : <>
      <section className="surface file-row"><div><FileSpreadsheet /><span><b>{fileName}</b><small>Hoja {sheetName} · {named.length} filas con producto</small></span></div><button className="btn ghost small" onClick={reset}><RotateCcw />Cambiar</button></section>
      <section className="surface section"><Step n="1" title="Relacioná las columnas" text="Solo Producto es obligatorio. Las demás columnas se importan si están disponibles." /><div className="mapping">{([["name", "Nombre del producto", true], ["code", "Código QR / barras", false], ["purchasePriceUsd", "Precio de compra USD", false], ["weightLb", "Peso en libras", false], ["quantityAvailable", "Cantidad disponible", false], ["minimumStock", "Stock mínimo", false]] as const).map(([key, label, required]) => <label className="field" key={key}><span>{label}{required && <em>*</em>}</span><select value={mapping[key]} onChange={(event) => setMapping({ ...mapping, [key]: event.target.value })}><option value="">No importar esta columna</option>{headers.map((header, index) => <option value={index} key={`${header}-${index}`}>{header}</option>)}</select></label>)}</div></section>
      <section className="surface section"><Step n="2" title="Cómo tratar los productos existentes" text={`${ready.length} productos listos · ${incomplete.length} incompletos${duplicates ? ` · ${duplicates} repetidos: se conservará la última aparición` : ""}. No se mostrará vista previa.`} /><div className="strategies"><label className={strategy === "update" ? "chosen" : ""}><input type="radio" checked={strategy === "update"} onChange={() => setStrategy("update")} /><span><b>Actualizar existentes</b><small>Solo reemplaza las columnas incluidas. Los cambios manuales posteriores se conservan.</small></span></label><label className={strategy === "skip" ? "chosen" : ""}><input type="radio" checked={strategy === "skip"} onChange={() => setStrategy("skip")} /><span><b>Omitir existentes</b><small>Agrega únicamente productos nuevos.</small></span></label></div><button className="btn primary full" disabled={mapping.name === "" || !ready.length || busy} onClick={() => void beginImport()}>{busy ? <Loader2 className="spin" /> : <Upload />}Importar {ready.length || ""} productos</button></section>
    </>)}

    {job?.status === "completed" && <section className="surface section import-summary"><Step n="✓" title="Resumen de la última importación" text={`${job.importedCount} nuevos · ${job.updatedCount} actualizados · ${job.incompleteCount} incompletos`} />{summary.length ? <><div className="summary-list">{summary.slice(0, summaryExpanded ? summary.length : 20).map(({ outcome, product }) => { const prices = hasCompletePricing(product) ? calculatePrices(product.purchasePriceUsd, product.weightLb, settings) : null; return <article key={`${outcome}-${product.id}`}><div><b>{product.name}</b><small>{outcome === "imported" ? "Nuevo" : "Actualizado"}{product.code ? ` · ${product.code}` : ""}</small></div><span><small>Stock</small><b>{product.quantityAvailable}{product.minimumStockEnabled ? ` / mín. ${product.minimumStock}` : ""}</b></span><span><small>GAM</small><b>{prices ? crc(prices.gamPriceCrc) : "Incompleto"}</b></span><span><small>Puerto</small><b>{prices ? crc(prices.puertoPriceCrc) : "Incompleto"}</b></span></article>; })}</div>{summary.length > 20 && <button className="btn secondary summary-toggle" onClick={() => setSummaryExpanded((current) => !current)}>{summaryExpanded ? "Mostrar solo los primeros 20" : `Mostrar los ${summary.length} productos`}</button>}</> : <p className="empty-summary">No hubo productos nuevos ni actualizados en esta importación.</p>}</section>}

    <section className="surface section import-history"><Step n="↶" title="Historial y respaldos" text="Cada importación conserva una copia completa del inventario anterior." />{history.length ? <div className="history-list">{history.map((item) => <article key={item.id}><div><b>{item.fileName}</b><small>{importDate(item.createdAt)}{item.restoredAt ? " · Restaurado" : ""}</small></div><span>{item.strategy === "backup" ? "Respaldo automático" : `${item.importedCount} nuevos · ${item.updatedCount} actualizados`}</span><button className="btn ghost small" onClick={() => setRestoreTarget(item)} disabled={restoringId !== null || item.status !== "completed"}><ArchiveRestore />Volver a este respaldo</button></article>)}</div> : <p className="empty-summary">El historial aparecerá después de la primera importación.</p>}</section>
    {notice && <p className={`alert ${notice.type}`}><AlertCircle />{notice.text}</p>}
    {restoreTarget && <div className="modal" role="dialog" aria-modal="true" aria-label="Confirmar restauración"><div className="confirm-card"><div className="download-symbol"><ArchiveRestore /></div><h2>¿Volver a este respaldo?</h2><p>Se restaurará el inventario que existía antes de <b>{restoreTarget.fileName}</b>. Primero se guardará otra copia del inventario actual para que también puedas recuperarlo.</p><div className="confirm-actions"><button className="btn secondary" onClick={() => setRestoreTarget(null)} disabled={restoringId !== null}>No, cancelar</button><button className="btn primary" onClick={() => { const target = restoreTarget; setRestoreTarget(null); void onRestore(target); }} disabled={restoringId !== null}><ArchiveRestore />Sí, restaurar</button></div></div></div>}
  </div>;
}

function SettingsView({ current, onSave }: { current: PricingSettings; onSave: (value: PricingSettings) => Promise<void> }) {
  const [draft, setDraft] = useState(current);
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
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); try { await onSave(draft); } finally { setBusy(false); } }
  return <div className="view"><header className="view-head"><span className="eyebrow">Valores generales</span><h1>Ajustes</h1><p>Los cambios recalculan todos los productos guardados.</p></header><form className="surface settings-form" onSubmit={submit}><div className="mapping">{fields.map(([key, label, prefix, suffix, step]) => <label className="field" key={key}><span>{label}</span><div className="number-box">{prefix && <i>{prefix}</i>}<input type="number" min="0" step={step} value={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: Number(event.target.value) })} />{suffix && <small>{suffix}</small>}</div></label>)}</div><div className="settings-note"><CircleDollarSign /><span>Se conservan el precio de compra y el peso; los precios de venta se actualizan con estos valores.</span></div><button className="btn primary full" disabled={busy}>{busy ? <Loader2 className="spin" /> : <Save />}Guardar ajustes</button></form></div>;
}

function Empty({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) { return <div className="empty">{icon}<h2>{title}</h2>{text && <p>{text}</p>}</div>; }

export function NutriPlusApp() {
  const [tab, setTab] = useState<Tab>("calculator");
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [form, setForm] = useState<Form>(EMPTY);
  const [products, setProducts] = useState<ProductRecord[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [scannerIntent, setScannerIntent] = useState<ScannerIntent | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [activeNumeric, setActiveNumeric] = useState<NumericField | null>(null);
  const [editingProductId, setEditingProductId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProductRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [exportConfirm, setExportConfirm] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [visibleCount, setVisibleCount] = useState(36);
  const [stockOnly, setStockOnly] = useState(false);
  const [phoneNotificationsEnabled, setPhoneNotificationsEnabled] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">("default");
  const [importJob, setImportJob] = useState<ImportJobRecord | null>(null);
  const [importHistory, setImportHistory] = useState<ImportJobRecord[]>([]);
  const [importSummary, setImportSummary] = useState<ImportChangedProduct[]>([]);
  const [restoringImportId, setRestoringImportId] = useState<number | null>(null);
  const deferredQuery = useDeferredValue(query);
  const searchBurst = useRef<BurstState>({ ...EMPTY_BURST });
  const toastTimer = useRef<number | null>(null);
  const importRunner = useRef<number | null>(null);

  const notify = useCallback((next: NonNullable<Toast>) => {
    setToast(next);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    if (!next.sticky) toastTimer.current = window.setTimeout(() => setToast(null), 3800);
  }, []);

  useEffect(() => {
    if (!toast || toast.sticky) return;
    const dismiss = () => setToast(null);
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [toast]);

  const clearForm = useCallback(() => {
    setForm(EMPTY);
    setEditingProductId(null);
    setActiveNumeric(null);
    setSuggestionsOpen(false);
  }, []);

  const refreshProducts = useCallback(async () => {
    const result = await json<{ products: ProductRecord[] }>(await fetch("/api/products?limit=1000"));
    setProducts(result.products);
  }, []);

  const refreshImportHistory = useCallback(async () => {
    const result = await json<{ jobs: ImportJobRecord[] }>(await fetch("/api/imports"));
    setImportHistory(result.jobs);
    return result.jobs;
  }, []);

  const runImport = useCallback(async (id: number) => {
    if (importRunner.current === id) return;
    importRunner.current = id;
    try {
      while (true) {
        const data = await json<{ job: ImportJobRecord }>(await fetch(`/api/imports/${id}/process`, { method: "POST" }));
        setImportJob(data.job);
        if (data.job.status === "completed") {
          const detail = await json<{ job: ImportJobRecord; changedProducts: ImportChangedProduct[] }>(await fetch(`/api/imports/${id}`));
          setImportJob(detail.job);
          setImportSummary(detail.changedProducts);
          await Promise.all([refreshProducts(), refreshImportHistory()]);
          notify({ type: "success", text: `Importación completada: ${detail.job.importedCount} nuevos y ${detail.job.updatedCount} actualizados.`, sticky: true });
          break;
        }
        if (data.job.status === "failed") {
          await refreshImportHistory();
          notify({ type: "error", text: "La importación se detuvo sin borrar el inventario anterior. Podés revisar el respaldo en Importar.", sticky: true });
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 35));
      }
    } catch (error) {
      notify({ type: "error", text: error instanceof Error ? `${error.message} La importación quedó guardada para poder reanudarla.` : "La importación quedó guardada para poder reanudarla.", sticky: true });
    } finally {
      if (importRunner.current === id) importRunner.current = null;
    }
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
        const [settingsResponse, productsResponse, importsResponse] = await Promise.all([fetch("/api/settings"), fetch("/api/products?limit=1000"), fetch("/api/imports")]);
        const settingsData = await json<{ settings: PricingSettings }>(settingsResponse);
        const productsData = await json<{ products: ProductRecord[] }>(productsResponse);
        const importsData = await json<{ jobs: ImportJobRecord[] }>(importsResponse);
        setSettings(settingsData.settings);
        setProducts(productsData.products);
        setImportHistory(importsData.jobs);
        const active = importsData.jobs.find((item) => item.status === "queued" || item.status === "running");
        const latest = active || importsData.jobs[0] || null;
        setImportJob(latest);
        if (active) void runImport(active.id);
        else if (latest?.status === "completed" && latest.strategy !== "backup") {
          void json<{ job: ImportJobRecord; changedProducts: ImportChangedProduct[] }>(await fetch(`/api/imports/${latest.id}`)).then((detail) => setImportSummary(detail.changedProducts)).catch(() => undefined);
        }
      } catch (error) {
        notify({ type: "error", text: error instanceof Error ? error.message : "No se pudo iniciar la app." });
      } finally {
        setLoading(false);
      }
    })();
    return () => window.clearTimeout(preloadTimer);
  }, [notify, runImport]);

  const suggestions = useMemo(() => searchProducts(products, form.name).filter((product) => product.id !== form.id).slice(0, 8), [form.id, form.name, products]);
  const lowStockProducts = useMemo(() => products.filter((product) => product.minimumStockEnabled && product.quantityAvailable <= product.minimumStock), [products]);
  const filteredProducts = useMemo(() => {
    const matches = searchProducts(products, deferredQuery);
    return stockOnly ? matches.filter((product) => product.minimumStockEnabled && product.quantityAvailable <= product.minimumStock) : matches;
  }, [deferredQuery, products, stockOnly]);

  const sendDailyStockNotification = useCallback(async (force = false) => {
    if (!phoneNotificationsEnabled || notificationPermission !== "granted" || !lowStockProducts.length || !("serviceWorker" in navigator)) return;
    const now = new Date();
    const dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const storageKey = "nutriplus-last-low-stock-notification";
    if (!force && window.localStorage.getItem(storageKey) === dayKey) return;
    const registration = await navigator.serviceWorker.ready;
    const names = lowStockProducts.slice(0, 3).map((product) => product.name).join(", ");
    await registration.showNotification("Stock bajo en NutriPlus", {
      body: `${lowStockProducts.length} producto${lowStockProducts.length === 1 ? " llegó" : "s llegaron"} al mínimo: ${names}${lowStockProducts.length > 3 ? "…" : ""}`,
      icon: "/nutriplus-logo.jpg",
      badge: "/nutriplus-logo.jpg",
      tag: "nutriplus-low-stock-daily",
      data: { url: "/?tab=products&stock=low" },
    });
    window.localStorage.setItem(storageKey, dayKey);
  }, [lowStockProducts, notificationPermission, phoneNotificationsEnabled]);

  const enableStockNotifications = useCallback(async () => {
    if (!("Notification" in window) || !("serviceWorker" in navigator)) {
      setNotificationPermission("unsupported");
      notify({ type: "error", text: "Este navegador no admite notificaciones de la app. Las alertas seguirán visibles dentro de Productos." });
      return;
    }
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    if (permission !== "granted") {
      notify({ type: "error", text: "No se activaron las notificaciones del celular. Podés permitirlas después desde los ajustes del navegador." });
      return;
    }
    window.localStorage.setItem("nutriplus-stock-notifications", "enabled");
    setPhoneNotificationsEnabled(true);
    const registration = await navigator.serviceWorker.ready;
    const periodic = (registration as ServiceWorkerRegistration & { periodicSync?: { register: (tag: string, options: { minInterval: number }) => Promise<void> } }).periodicSync;
    if (periodic) await periodic.register("nutriplus-low-stock", { minInterval: 24 * 60 * 60 * 1000 }).catch(() => undefined);
    notify({ type: "success", text: "Notificaciones de stock activadas en este celular." });
  }, [notify]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!("Notification" in window) || !("serviceWorker" in navigator)) {
        setNotificationPermission("unsupported");
        return;
      }
      setNotificationPermission(Notification.permission);
      const enabled = window.localStorage.getItem("nutriplus-stock-notifications") === "enabled";
      setPhoneNotificationsEnabled(enabled && Notification.permission === "granted");
      const params = new URLSearchParams(window.location.search);
      if (params.get("tab") === "products") setTab("products");
      if (params.get("stock") === "low") setStockOnly(true);
    }, 0);
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!lowStockProducts.length) window.localStorage.removeItem("nutriplus-last-low-stock-notification");
    void sendDailyStockNotification();
    const timer = window.setInterval(() => { void sendDailyStockNotification(); }, 30 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [lowStockProducts.length, sendDailyStockNotification]);

  const fillCalculator = useCallback((product: ProductRecord) => {
    setForm(productToForm(product));
    setEditingProductId(null);
    setActiveNumeric(null);
    setSuggestionsOpen(false);
    setTab("calculator");
  }, []);

  const editInProducts = useCallback((product: ProductRecord) => {
    setForm(productToForm(product));
    setEditingProductId(product.id);
    setActiveNumeric(null);
    setSuggestionsOpen(false);
    setTab("products");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const assignCode = useCallback((code: string) => {
    const cleanCode = code.trim();
    if (!cleanCode) return;
    setScannerIntent(null);
    setForm((current) => ({ ...current, code: cleanCode }));
    setSuggestionsOpen(false);
    notify({ type: "success", text: "Código agregado. Podés guardar los cambios sin salir de esta pantalla." });
  }, [notify]);

  const lookupCode = useCallback(async (code: string, destination: "products" | "calculator") => {
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
        if (destination === "products") {
          clearForm();
          setStockOnly(false);
          setQuery(cleanCode);
          setVisibleCount(36);
          setTab("products");
          window.scrollTo({ top: 0, behavior: "smooth" });
        } else {
          fillCalculator(product);
        }
        notify({ type: "success", text: `Encontramos ${product.name}.` });
      } else if (destination === "products") {
        clearForm();
        setStockOnly(false);
        setQuery(cleanCode);
        setVisibleCount(36);
        setTab("products");
        notify({ type: "error", text: "No encontramos un producto guardado con ese código." });
      } else {
        setForm({ ...EMPTY, code: cleanCode });
        setEditingProductId(null);
        setActiveNumeric(null);
        setTab("calculator");
        notify({ type: "success", text: "Código nuevo. Completá los datos para guardarlo." });
      }
    } catch (error) {
      notify({ type: "error", text: error instanceof Error ? error.message : "No se pudo buscar el código." });
    }
  }, [clearForm, fillCalculator, notify, products]);

  const openScanner = useCallback((intent: ScannerIntent) => {
    setScannerIntent(intent);
  }, []);

  const handleScannerCode = useCallback((code: string) => {
    if (scannerIntent === "assign") assignCode(code);
    else if (scannerIntent === "lookup-products") void lookupCode(code, "products");
    else if (scannerIntent === "lookup-calculator") void lookupCode(code, "calculator");
  }, [assignCode, lookupCode, scannerIntent]);

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
          if (tab === "calculator" || (tab === "products" && editingProductId !== null)) assignCode(buffer);
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
  }, [assignCode, editingProductId, lookupCode, tab]);

  const price = form.purchasePriceUsd.trim() ? Number(form.purchasePriceUsd) : null;
  const weight = form.weightLb.trim() ? Number(form.weightLb) : null;
  const validPrice = price === null || (Number.isFinite(price) && price >= 0);
  const validWeight = weight === null || (Number.isFinite(weight) && weight >= 0);
  const completePricing = price !== null && validPrice && weight !== null && validWeight;
  const showPriceBar = tab === "calculator" || (tab === "products" && editingProductId !== null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.name.trim()) return notify({ type: "error", text: "El nombre del producto es obligatorio." });
    const quantityAvailable = form.quantityAvailable.trim() ? Number(form.quantityAvailable) : 0;
    const minimumStock = form.minimumStockEnabled && form.minimumStock.trim() ? Number(form.minimumStock) : 0;
    if (!Number.isInteger(quantityAvailable) || quantityAvailable < 0 || !Number.isInteger(minimumStock) || minimumStock < 0) {
      return notify({ type: "error", text: "La cantidad y el stock mínimo deben ser números enteros iguales o mayores que cero." });
    }
    const submittedForm = { ...form, name: form.name.trim(), code: form.code.trim() };
    const editing = Boolean(submittedForm.id);
    const existing = submittedForm.id === null ? null : products.find((product) => product.id === submittedForm.id) || null;
    const optimistic = existing ? {
      ...existing,
      name: submittedForm.name,
      code: submittedForm.code || null,
      purchasePriceUsd: price,
      weightLb: weight,
      quantityAvailable,
      minimumStock,
      minimumStockEnabled: submittedForm.minimumStockEnabled,
      updatedAt: new Date().toISOString(),
    } : null;

    if (optimistic) {
      setProducts((current) => [optimistic, ...current.filter((product) => product.id !== optimistic.id)]);
      clearForm();
      notify({ type: "success", text: "Cambios aplicados. Terminando de guardarlos…" });
    }
    setSaving(true);
    try {
      const data = await json<{ product: ProductRecord }>(await fetch(submittedForm.id ? `/api/products/${submittedForm.id}` : "/api/products", {
        method: submittedForm.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...submittedForm, purchasePriceUsd: price, weightLb: weight, quantityAvailable, minimumStock, minimumStockEnabled: submittedForm.minimumStockEnabled }),
      }));
      setProducts((current) => [data.product, ...current.filter((product) => product.id !== data.product.id)]);
      if (!editing) clearForm();
      notify({ type: "success", text: editing ? "Producto actualizado y guardado." : completePricing ? "Cotización guardada. Las casillas quedaron limpias." : "Producto incompleto guardado. Las casillas quedaron limpias." });
    } catch (error) {
      if (existing) {
        setProducts((current) => [existing, ...current.filter((product) => product.id !== existing.id)]);
        setForm(submittedForm);
        setEditingProductId(tab === "products" ? existing.id : null);
      }
      notify({ type: "error", text: error instanceof Error ? error.message : "No se pudo guardar." });
    } finally {
      setSaving(false);
    }
  }

  async function removeProduct() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await json<{ deleted: boolean }>(await fetch(`/api/products/${deleteTarget.id}`, { method: "DELETE" }));
      setProducts((current) => current.filter((product) => product.id !== deleteTarget.id));
      if (form.id === deleteTarget.id) clearForm();
      notify({ type: "success", text: `${deleteTarget.name} fue eliminado.` });
      setDeleteTarget(null);
    } catch (error) {
      notify({ type: "error", text: error instanceof Error ? error.message : "No se pudo eliminar el producto." });
    } finally {
      setDeleting(false);
    }
  }

  async function downloadInventory() {
    if (!products.length) {
      setExportConfirm(false);
      notify({ type: "error", text: "Todavía no hay productos para descargar." });
      return;
    }
    setExporting(true);
    try {
      const { exportInventoryFiles } = await import("@/lib/export-inventory");
      const result = await exportInventoryFiles(products, settings);
      setExportConfirm(false);
      notify({ type: "success", text: `Excel y PDF descargados por separado: ${result.complete} completos y ${result.incomplete} incompletos.` });
    } catch (error) {
      setExportConfirm(false);
      notify({ type: "error", text: error instanceof Error ? error.message : "No se pudieron generar las descargas." });
    } finally {
      setExporting(false);
    }
  }

  async function saveSettings(next: PricingSettings) {
    try {
      const data = await json<{ settings: PricingSettings }>(await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) }));
      setSettings(data.settings);
      notify({ type: "success", text: "Ajustes guardados. Todos los precios fueron recalculados." });
    } catch (error) {
      notify({ type: "error", text: error instanceof Error ? error.message : "No se pudieron guardar." });
      throw error;
    }
  }

  const nav: Array<[Tab, string, typeof Calculator]> = [["calculator", "Calcular", Calculator], ["products", "Productos", PackageSearch], ["import", "Importar", FileSpreadsheet], ["settings", "Ajustes", Settings]];
  if (loading) return <main className="loading"><span className="brand-mark">N+</span><Loader2 className="spin" />Preparando NutriPlus…</main>;

  return <main className="app-shell">
    {showPriceBar && <StickyPrices price={validPrice ? price : null} weight={validWeight ? weight : null} settings={settings} />}
    <div className="body"><aside className={`side ${showPriceBar ? "under-price" : ""}`}><span>Menú</span>{nav.map(([id, label, Icon]) => <button className={tab === id ? "active" : ""} onClick={() => setTab(id)} key={id}><Icon />{label}</button>)}<div className="weight-note"><Weight /><span><b>+{settings.extraWeightLb.toFixed(2)} lb</b><small>en cada cálculo</small></span></div></aside><div className="content">
      {tab === "calculator" && <div className="view calculator-view"><header className="compact-head"><div><span className="eyebrow">Cotización rápida</span><h1>{form.id ? "Actualizar producto" : "Calcular precio"}</h1></div><button className="btn ghost small" onClick={clearForm}><RotateCcw />Limpiar</button></header><ProductForm form={form} setForm={setForm} settings={settings} suggestions={suggestions} suggestionsOpen={suggestionsOpen} setSuggestionsOpen={setSuggestionsOpen} onPick={fillCalculator} onExternalCode={assignCode} onOpenScanner={() => openScanner("assign")} onSubmit={save} saving={saving} activeNumeric={activeNumeric} setActiveNumeric={setActiveNumeric} /></div>}

      {tab === "products" && <div className="view"><header className="view-head products-head"><div><span className="eyebrow">Historial guardado</span><h1>Productos</h1><p>Buscá, editá existencias o descargá el inventario.</p></div><button className="btn primary export-btn" onClick={() => setExportConfirm(true)} disabled={!products.length}><Download />Descargar inventario</button></header>
        <section className={`surface stock-alert-panel ${lowStockProducts.length ? "has-alerts" : ""}`}><div className="stock-alert-heading"><span className="stock-alert-icon">{lowStockProducts.length ? <BellRing /> : <Bell />}</span><div><h2>{lowStockProducts.length ? `${lowStockProducts.length} producto${lowStockProducts.length === 1 ? " con" : "s con"} stock bajo` : "Stock mínimo al día"}</h2><p>La alerta aparece al llegar o bajar del mínimo y se repite diariamente en este celular.</p></div></div>{lowStockProducts.length > 0 && <div className="low-stock-chips">{lowStockProducts.slice(0, 6).map((product) => <span key={product.id}><b>{product.name}</b>{product.quantityAvailable} / mín. {product.minimumStock}</span>)}{lowStockProducts.length > 6 && <span>+{lowStockProducts.length - 6} más</span>}</div>}<div className="stock-alert-actions"><button className={`btn ${stockOnly ? "primary" : "ghost"} small`} onClick={() => { setStockOnly((current) => !current); setVisibleCount(36); }}>{stockOnly ? "Ver todos" : "Ver solo stock bajo"}</button><button className="btn secondary small" onClick={() => void enableStockNotifications()} disabled={phoneNotificationsEnabled}>{phoneNotificationsEnabled ? <Check /> : <Bell />}{phoneNotificationsEnabled ? "Notificaciones activadas" : notificationPermission === "denied" ? "Permiso bloqueado" : "Activar en el celular"}</button></div></section>
        {editingProductId !== null && <section className="editor-wrap"><div className="editor-heading"><div><span className="eyebrow">Edición en Productos</span><h2>{form.name}</h2></div><button className="icon-btn" onClick={clearForm} aria-label="Cerrar edición"><X /></button></div><ProductForm form={form} setForm={setForm} settings={settings} suggestions={[]} suggestionsOpen={false} setSuggestionsOpen={() => undefined} onPick={() => undefined} onExternalCode={assignCode} onOpenScanner={() => openScanner("assign")} onSubmit={save} onCancel={clearForm} saving={saving} activeNumeric={activeNumeric} setActiveNumeric={setActiveNumeric} showSuggestions={false} /></section>}
        <section className="surface search-card"><div className="input-icon grow"><Search /><input value={query} onChange={(event) => { setQuery(event.target.value); setVisibleCount(36); }} onKeyDown={(event) => detectScannerBurst(event, searchBurst, (code, before) => { setQuery(before); setVisibleCount(36); void lookupCode(code, "products"); })} placeholder="Ej. omega encargo o omega nordic" /></div><button className="scan-btn" onPointerDown={() => void preloadScanner()} onClick={() => openScanner("lookup-products")}><Camera /><span>Escanear</span></button></section>
        {!filteredProducts.length ? <Empty icon={<PackageSearch />} title={query || stockOnly ? "No hay coincidencias" : "Todavía no hay productos"} text={stockOnly ? "No hay productos en alerta de stock mínimo." : query ? "Probá con otras palabras o escaneá el código." : "Las cotizaciones guardadas aparecerán aquí."} /> : <><div className="results-count">{stockOnly ? `${filteredProducts.length} con stock bajo` : query ? `${filteredProducts.length} coincidencias` : `${products.length} productos guardados`}</div><div className="product-grid">{filteredProducts.slice(0, visibleCount).map((product) => { const complete = hasCompletePricing(product); const prices = complete ? calculatePrices(product.purchasePriceUsd, product.weightLb, settings) : null; const lowStock = product.minimumStockEnabled && product.quantityAvailable <= product.minimumStock; return <article className={`product-card ${complete ? "" : "pending-product"} ${lowStock ? "low-stock" : ""}`} key={product.id}><div className="product-title"><span className="avatar">{product.name[0].toUpperCase()}</span><div><h2>{product.name}</h2>{product.code && <small><ScanLine />{product.code}</small>}{!complete && <small className="pending-label"><AlertCircle />Incompleto</small>}{lowStock && <small className="stock-label"><AlertCircle />Stock bajo</small>}</div><div className="card-actions"><button className="icon-btn" onClick={() => editInProducts(product)} aria-label={`Editar ${product.name}`}><Pencil /></button><button className="icon-btn danger" onClick={() => setDeleteTarget(product)} aria-label={`Eliminar ${product.name}`}><Trash2 /></button></div></div><div className="facts"><div><span>Compra</span><b>{product.purchasePriceUsd === null ? "—" : usd(product.purchasePriceUsd)}</b></div><div><span>Peso</span><b>{product.weightLb === null ? "—" : `${product.weightLb.toFixed(2)} lb`}</b></div><div className="green"><span>Venta GAM</span><b>{prices ? crc(prices.gamPriceCrc) : "Incompleto"}</b></div><div className="brown"><span>Venta Puerto</span><b>{prices ? crc(prices.puertoPriceCrc) : "Incompleto"}</b></div><div className="stock"><span>Cantidad disponible</span><b>{product.quantityAvailable}</b></div><div className="stock"><span>Stock mínimo</span><b>{product.minimumStockEnabled ? product.minimumStock : "No configurado"}</b></div></div></article>; })}</div>{visibleCount < filteredProducts.length && <button className="btn secondary load-more" onClick={() => setVisibleCount((current) => current + 36)}>Mostrar más productos</button>}</>}
      </div>}

      {tab === "import" && <ImportView settings={settings} job={importJob} history={importHistory} summary={importSummary} restoringId={restoringImportId} onStart={startImport} onRestore={restoreImport} />}
      {tab === "settings" && <SettingsView key={JSON.stringify(settings)} current={settings} onSave={saveSettings} />}
    </div></div>
    <nav className="bottom">{nav.map(([id, label, Icon]) => <button className={tab === id ? "active" : ""} onClick={() => setTab(id)} key={id}><Icon />{label}</button>)}</nav><button className="float-scan" onPointerDown={() => void preloadScanner()} onClick={() => openScanner(tab === "products" ? (editingProductId !== null ? "assign" : "lookup-products") : "lookup-calculator")} aria-label="Escanear"><ScanLine /></button>
    {scannerIntent && <Scanner onClose={() => setScannerIntent(null)} onCode={handleScannerCode} />}
    {exportConfirm && <div className="modal" role="dialog" aria-modal="true" aria-label="Confirmar descarga del inventario"><div className="confirm-card"><div className="download-symbol"><Download /></div><h2>¿Descargar inventario?</h2><p>Se descargarán <b>dos archivos separados</b>: un Excel y un PDF. Ambos incluirán {products.length} productos, con los incompletos en otra hoja o sección.</p><div className="confirm-actions"><button className="btn secondary" onClick={() => setExportConfirm(false)} disabled={exporting}>No, cancelar</button><button className="btn primary" onClick={() => void downloadInventory()} disabled={exporting}>{exporting ? <Loader2 className="spin" /> : <Download />}Sí, descargar ambos</button></div></div></div>}
    {deleteTarget && <div className="modal" role="dialog" aria-modal="true" aria-label="Confirmar eliminación"><div className="confirm-card"><div className="delete-symbol"><Trash2 /></div><h2>¿Eliminar producto?</h2><p>Vas a eliminar <b>{deleteTarget.name}</b>. Esta acción no se puede deshacer.</p><div className="confirm-actions"><button className="btn secondary" onClick={() => setDeleteTarget(null)} disabled={deleting}>No, cancelar</button><button className="btn danger-solid" onClick={() => void removeProduct()} disabled={deleting}>{deleting ? <Loader2 className="spin" /> : <Trash2 />}Sí, eliminar</button></div></div></div>}
    {toast && <div className={`toast ${toast.type} ${toast.sticky ? "sticky" : ""}`} role="status" aria-live="polite">{toast.type === "success" ? <Check /> : <AlertCircle />}<span>{toast.text}</span><button onClick={() => setToast(null)} aria-label="Cerrar notificación"><X /></button></div>}
  </main>;
}
