"use client";

import {
  AlertCircle,
  Calculator,
  Camera,
  Check,
  ChevronDown,
  CircleDollarSign,
  Delete as DeleteKey,
  FileSpreadsheet,
  Flashlight,
  Loader2,
  MapPin,
  Package,
  PackageSearch,
  Pencil,
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
type Form = { id: number | null; name: string; code: string; purchasePriceUsd: string; weightLb: string };
type Toast = { type: "success" | "error"; text: string } | null;
type Mapping = { name: string; purchasePriceUsd: string; weightLb: string; code: string };
type BurstState = { text: string; startedAt: number; lastAt: number; valueBefore: string };

const EMPTY: Form = { id: null, name: "", code: "", purchasePriceUsd: "", weightLb: "" };
const EMPTY_BURST: BurstState = { text: "", startedAt: 0, lastAt: 0, valueBefore: "" };
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", ".", "backspace"] as const;

let scannerModulePromise: Promise<typeof import("@zxing/browser")> | null = null;
function preloadScanner() {
  scannerModulePromise ??= import("@zxing/browser");
  return scannerModulePromise;
}

type BarcodeResult = { rawValue: string };
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
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(true);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

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
              controls?.stop();
              onCode(result.getText());
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
              const value = results.find((result) => result.rawValue.trim())?.rawValue.trim();
              if (value && !stopped) {
                onCode(value);
                return;
              }
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
  }, [applyTorch, onCode]);

  return <div className="modal" role="dialog" aria-modal="true" aria-label="Escáner de producto"><div className="scanner-card">
    <div className="modal-head"><div><span className="eyebrow">Cámara</span><h2>Escanear producto</h2></div><button className="icon-btn" onClick={onClose} aria-label="Cerrar"><X /></button></div>
    <div className="camera"><video ref={video} muted playsInline /><canvas ref={canvas} hidden /><div className="scan-frame" />{starting && <div className="camera-state"><Loader2 className="spin" />Abriendo cámara…</div>}</div>
    {error ? <p className="alert error"><AlertCircle size={17} />{error}</p> : <div className="scanner-help"><p className="hint">Colocá el QR o código de barras dentro del recuadro.</p>{torchAvailable && <button className={`torch-btn ${torchOn ? "active" : ""}`} onClick={() => { autoTorchEnabledRef.current = false; void applyTorch(!torchOn); }}><Flashlight />{torchOn ? "Apagar linterna" : "Encender linterna"}</button>}</div>}
    {torchAvailable && <p className="auto-light">La linterna se activa automáticamente si detecta poca luz.</p>}
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
  return <div className="numeric-keypad" aria-label="Teclado numérico"><div className="keypad-head"><span>Ingresando {active === "purchasePriceUsd" ? "precio" : "peso"}</span><button type="button" onClick={onClose} aria-label="Ocultar teclado"><X /></button></div><div className="keypad-grid">
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
  const completePricing = price !== null && validPrice && weight !== null && validWeight;
  const validForm = Boolean(form.name.trim()) && validPrice && validWeight;

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
    <label className="field name-field"><span>Nombre del producto <em>*</em></span><div className="input-icon"><Package /><input value={form.name} onChange={(event) => { setForm({ ...form, name: event.target.value }); setSuggestionsOpen(true); }} onKeyDown={(event) => detectScannerBurst(event, nameBurst, (code, before) => { setForm((current) => ({ ...current, name: before, code })); onExternalCode(code); })} onFocus={() => setSuggestionsOpen(true)} onBlur={() => window.setTimeout(() => setSuggestionsOpen(false), 160)} placeholder="Ej. Omega 3 Nordic encargo" required /></div>{showSuggestions && suggestionsOpen && form.name.trim() && suggestions.length > 0 && <div className="suggestions"><small>Productos encontrados</small>{suggestions.slice(0, 7).map((product) => <button type="button" onMouseDown={() => onPick(product)} key={product.id}><b>{product.name}</b><span>{product.purchasePriceUsd === null ? "Compra pendiente" : usd(product.purchasePriceUsd)} · {product.weightLb === null ? "peso pendiente" : `${product.weightLb.toFixed(2)} lb`}</span></button>)}</div>}<p className="hint">Podés buscar con varias palabras aunque no estén seguidas.</p></label>
    <label className="field"><span>Código QR o de barras <small>Opcional</small></span><div className="code-row"><div className="input-icon grow"><ScanLine /><input value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); const code = event.currentTarget.value.trim(); if (code) setForm((current) => ({ ...current, code })); } }} placeholder="Escaneá o escribí el código" autoComplete="off" /></div><button type="button" className="scan-btn" onPointerDown={() => void preloadScanner()} onClick={onOpenScanner}><Camera /><span>Escanear</span></button></div></label>
    <div className="two"><label className="field"><span>Precio de compra</span><div className={`number-box tappable ${activeNumeric === "purchasePriceUsd" ? "active" : ""}`}><i>$</i><input type="text" inputMode="none" readOnly value={form.purchasePriceUsd} onFocus={() => setActiveNumeric("purchasePriceUsd")} onClick={() => setActiveNumeric("purchasePriceUsd")} placeholder="Pendiente" /></div><p className="hint">En dólares</p></label><label className="field"><span>Peso</span><div className={`number-box tappable ${activeNumeric === "weightLb" ? "active" : ""}`}><input type="text" inputMode="none" readOnly value={form.weightLb} onFocus={() => setActiveNumeric("weightLb")} onClick={() => setActiveNumeric("weightLb")} placeholder="Pendiente" /><small>lb</small></div><p className="hint">Se suman {settings.extraWeightLb.toFixed(2)} lb.</p></label></div>
    {activeNumeric && <NumericKeypad active={activeNumeric} onKey={keypad} onClose={() => setActiveNumeric(null)} />}
    {!form.name.trim() && (form.purchasePriceUsd || form.weightLb) && <p className="alert warning"><AlertCircle />Agregá el nombre para guardar.</p>}{form.name.trim() && !completePricing && <p className="alert warning"><AlertCircle />Podés guardarlo como pendiente y completar los datos después.</p>}
    <div className={`form-actions ${onCancel ? "split" : ""}`}>{onCancel && <button type="button" className="btn secondary" onClick={onCancel}>Cancelar</button>}<button className="btn primary" disabled={!validForm || saving}>{saving ? <Loader2 className="spin" /> : <Save />}{completePricing ? (form.id ? "Guardar cambios" : "Guardar cotización") : "Guardar pendiente"}</button></div>
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

function ImportView({ settings, afterImport }: { settings: PricingSettings; afterImport: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [sheetName, setSheetName] = useState("");
  const [firstDataRow, setFirstDataRow] = useState(2);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<unknown[][]>([]);
  const [mapping, setMapping] = useState<Mapping>({ name: "", purchasePriceUsd: "", weightLb: "", code: "" });
  const [strategy, setStrategy] = useState<"update" | "skip">("update");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Toast>(null);
  const mapped = useMemo(() => rows.map((row, i) => ({
    rowNumber: i + firstDataRow,
    name: mapping.name === "" ? "" : String(row[Number(mapping.name)] ?? "").trim(),
    purchasePriceUsd: mapping.purchasePriceUsd === "" ? null : parseNumber(row[Number(mapping.purchasePriceUsd)]),
    weightLb: mapping.weightLb === "" ? null : parseNumber(row[Number(mapping.weightLb)]),
    code: mapping.code === "" ? "" : String(row[Number(mapping.code)] ?? "").trim(),
  })), [firstDataRow, mapping, rows]);
  const named = mapped.filter((row) => row.name);
  const ready = [...new Map(named.map((row) => [normalizeName(row.name), row])).values()];
  const duplicates = named.length - ready.length;
  const pending = ready.filter((row) => row.purchasePriceUsd === null || row.weightLb === null);
  const complete = mapping.name !== "" && mapping.purchasePriceUsd !== "" && mapping.weightLb !== "";

  async function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setNotice(null);
    try {
      const XLSX = await import("xlsx");
      const book = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const selectedSheet = book.SheetNames.find((name) => normalizeName(name) === "compu") || book.SheetNames[0];
      const data = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[selectedSheet], { header: 1, defval: "", raw: true });
      if (data.length < 2) throw new Error("El archivo no contiene productos.");
      const headerIndex = data.findIndex((row) => row.some((cell) => normalizeName(String(cell)) === "producto"));
      if (headerIndex < 0) throw new Error("No se encontró la columna Producto.");
      const nextHeaders = data[headerIndex].map((cell, i) => String(cell || `Columna ${i + 1}`).trim());
      const normalized = nextHeaders.map(normalizeName);
      const find = (...tests: RegExp[]) => { const i = normalized.findIndex((head) => tests.some((test) => test.test(head))); return i < 0 ? "" : String(i); };
      setFileName(file.name);
      setSheetName(selectedSheet);
      setFirstDataRow(headerIndex + 2);
      setHeaders(nextHeaders);
      setRows(data.slice(headerIndex + 1).filter((row) => row.some((cell) => String(cell).trim())));
      setMapping({ name: find(/nombre/, /producto/, /descripcion/), purchasePriceUsd: find(/precio.*compra/, /precio.*producto/, /costo.*usd/, /^precio$/), weightLb: find(/peso/, /libras/, /^lb$/), code: find(/codigo/, /barra/, /barcode/, /^qr$/) });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "No se pudo leer el archivo." });
    } finally {
      setBusy(false);
      event.target.value = "";
    }
  }

  async function importRows() {
    setBusy(true);
    setNotice(null);
    try {
      const result = await json<{ imported: number; updated: number; skipped: number; errors: unknown[] }>(await fetch("/api/products/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: ready, strategy }) }));
      setNotice({ type: result.errors.length ? "error" : "success", text: `${result.imported} nuevos, ${result.updated} actualizados y ${result.skipped} omitidos.${result.errors.length ? ` ${result.errors.length} filas necesitan revisión.` : ""}` });
      afterImport();
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "No se pudo importar." });
    } finally {
      setBusy(false);
    }
  }

  const reset = () => { setHeaders([]); setRows([]); setFileName(""); setSheetName(""); setNotice(null); };
  return <div className="view"><header className="view-head"><span className="eyebrow">Carga masiva</span><h1>Importar Excel</h1><p>Cargá tus productos y revisalos antes de guardar.</p></header>
    {!headers.length ? <section className="surface upload" onClick={() => input.current?.click()}><div className="upload-icon"><FileSpreadsheet /></div><h2>{busy ? "Leyendo archivo…" : "Seleccioná tu archivo"}</h2><p>.xlsx, .xlsm, .xls o .csv</p><button className="btn primary" disabled={busy}><Upload />Elegir archivo</button><input ref={input} type="file" accept=".xlsx,.xlsm,.xls,.csv" onChange={pick} hidden /></section> : <>
      <section className="surface file-row"><div><FileSpreadsheet /><span><b>{fileName}</b><small>Hoja {sheetName} · {named.length} filas con producto</small></span></div><button className="btn ghost small" onClick={reset}><RotateCcw />Cambiar</button></section>
      <section className="surface section"><Step n="1" title="Relacioná las columnas" text="Elegí qué columna corresponde a cada dato." /><div className="mapping">{([["name", "Nombre del producto", true], ["purchasePriceUsd", "Precio de compra USD", true], ["weightLb", "Peso en libras", true], ["code", "Código QR / barras", false]] as const).map(([key, label, required]) => <label className="field" key={key}><span>{label}{required && <em>*</em>}</span><select value={mapping[key]} onChange={(event) => setMapping({ ...mapping, [key]: event.target.value })}><option value="">Seleccionar columna</option>{headers.map((header, i) => <option value={i} key={`${header}-${i}`}>{header}</option>)}</select></label>)}</div></section>
      <section className="surface section"><Step n="2" title="Vista previa" text={complete ? `${ready.length} productos: ${pending.length} pendientes${duplicates ? ` · ${duplicates} repetidos resueltos con la última aparición` : ""}` : "Completá las columnas obligatorias."} /><div className="table-wrap"><table><thead><tr><th>Producto</th><th>Compra</th><th>Peso</th><th>GAM</th><th>Puerto</th><th>Estado</th></tr></thead><tbody>{ready.slice(0, 6).map((row) => {
        const ok = row.purchasePriceUsd !== null && row.purchasePriceUsd >= 0 && row.weightLb !== null && row.weightLb >= 0;
        const prices = ok ? calculatePrices(row.purchasePriceUsd!, row.weightLb!, settings) : null;
        return <tr key={row.rowNumber}><td><b>{row.name}</b>{row.code && <small>{row.code}</small>}</td><td>{row.purchasePriceUsd !== null ? usd(row.purchasePriceUsd) : "—"}</td><td>{row.weightLb !== null ? `${row.weightLb.toFixed(2)} lb` : "—"}</td><td>{prices ? crc(prices.gamPriceCrc) : "—"}</td><td>{prices ? crc(prices.puertoPriceCrc) : "—"}</td><td><span className={`pill ${ok ? "ok" : "bad"}`}>{ok ? <Check /> : <AlertCircle />}{ok ? "Lista" : "Pendiente"}</span></td></tr>;
      })}</tbody></table></div></section>
      <section className="surface section"><Step n="3" title="Productos ya guardados" text="Elegí qué hacer si el nombre o código ya existe en la app." /><div className="strategies"><label className={strategy === "update" ? "chosen" : ""}><input type="radio" checked={strategy === "update"} onChange={() => setStrategy("update")} /><span><b>Actualizar existentes</b><small>Reemplaza precio y peso.</small></span></label><label className={strategy === "skip" ? "chosen" : ""}><input type="radio" checked={strategy === "skip"} onChange={() => setStrategy("skip")} /><span><b>Omitir existentes</b><small>Conserva los datos guardados.</small></span></label></div><button className="btn primary full" disabled={!complete || !ready.length || busy} onClick={importRows}>{busy ? <Loader2 className="spin" /> : <Upload />}Importar {ready.length || ""} productos</button></section>
    </>}{notice && <p className={`alert ${notice.type}`}><AlertCircle />{notice.text}</p>}
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
  const [visibleCount, setVisibleCount] = useState(36);
  const deferredQuery = useDeferredValue(query);
  const searchBurst = useRef<BurstState>({ ...EMPTY_BURST });
  const toastTimer = useRef<number | null>(null);

  const notify = useCallback((next: NonNullable<Toast>) => {
    setToast(next);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3800);
  }, []);

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

  useEffect(() => {
    const preloadTimer = window.setTimeout(() => { void preloadScanner().catch(() => undefined); }, 700);
    (async () => {
      try {
        const [settingsResponse, productsResponse] = await Promise.all([fetch("/api/settings"), fetch("/api/products?limit=1000")]);
        const settingsData = await json<{ settings: PricingSettings }>(settingsResponse);
        const productsData = await json<{ products: ProductRecord[] }>(productsResponse);
        setSettings(settingsData.settings);
        setProducts(productsData.products);
      } catch (error) {
        notify({ type: "error", text: error instanceof Error ? error.message : "No se pudo iniciar la app." });
      } finally {
        setLoading(false);
      }
    })();
    return () => window.clearTimeout(preloadTimer);
  }, [notify]);

  const suggestions = useMemo(() => searchProducts(products, form.name).filter((product) => product.id !== form.id).slice(0, 8), [form.id, form.name, products]);
  const filteredProducts = useMemo(() => searchProducts(products, deferredQuery), [deferredQuery, products]);

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
    const submittedForm = { ...form, name: form.name.trim(), code: form.code.trim() };
    const editing = Boolean(submittedForm.id);
    const existing = submittedForm.id === null ? null : products.find((product) => product.id === submittedForm.id) || null;
    const optimistic = existing ? {
      ...existing,
      name: submittedForm.name,
      code: submittedForm.code || null,
      purchasePriceUsd: price,
      weightLb: weight,
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
        body: JSON.stringify({ ...submittedForm, purchasePriceUsd: price, weightLb: weight }),
      }));
      setProducts((current) => [data.product, ...current.filter((product) => product.id !== data.product.id)]);
      if (!editing) clearForm();
      notify({ type: "success", text: editing ? "Producto actualizado y guardado." : completePricing ? "Cotización guardada. Las casillas quedaron limpias." : "Producto pendiente guardado. Las casillas quedaron limpias." });
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

      {tab === "products" && <div className="view"><header className="view-head"><span className="eyebrow">Historial guardado</span><h1>Productos</h1><p>Buscá con palabras separadas, QR o código de barras.</p></header>
        {editingProductId !== null && <section className="editor-wrap"><div className="editor-heading"><div><span className="eyebrow">Edición en Productos</span><h2>{form.name}</h2></div><button className="icon-btn" onClick={clearForm} aria-label="Cerrar edición"><X /></button></div><ProductForm form={form} setForm={setForm} settings={settings} suggestions={[]} suggestionsOpen={false} setSuggestionsOpen={() => undefined} onPick={() => undefined} onExternalCode={assignCode} onOpenScanner={() => openScanner("assign")} onSubmit={save} onCancel={clearForm} saving={saving} activeNumeric={activeNumeric} setActiveNumeric={setActiveNumeric} showSuggestions={false} /></section>}
        <section className="surface search-card"><div className="input-icon grow"><Search /><input value={query} onChange={(event) => { setQuery(event.target.value); setVisibleCount(36); }} onKeyDown={(event) => detectScannerBurst(event, searchBurst, (code, before) => { setQuery(before); setVisibleCount(36); void lookupCode(code, "products"); })} placeholder="Ej. omega encargo o omega nordic" /></div><button className="scan-btn" onPointerDown={() => void preloadScanner()} onClick={() => openScanner("lookup-products")}><Camera /><span>Escanear</span></button></section>
        {!filteredProducts.length ? <Empty icon={<PackageSearch />} title={query ? "No hay coincidencias" : "Todavía no hay productos"} text={query ? "Probá con otras palabras o escaneá el código." : "Las cotizaciones guardadas aparecerán aquí."} /> : <><div className="results-count">{query ? `${filteredProducts.length} coincidencias` : `${products.length} productos guardados`}</div><div className="product-grid">{filteredProducts.slice(0, visibleCount).map((product) => { const complete = hasCompletePricing(product); const prices = complete ? calculatePrices(product.purchasePriceUsd, product.weightLb, settings) : null; return <article className={`product-card ${complete ? "" : "pending-product"}`} key={product.id}><div className="product-title"><span className="avatar">{product.name[0].toUpperCase()}</span><div><h2>{product.name}</h2>{product.code ? <small><ScanLine />{product.code}</small> : !complete && <small className="pending-label"><AlertCircle />Pendiente</small>}</div><div className="card-actions"><button className="icon-btn" onClick={() => editInProducts(product)} aria-label={`Editar ${product.name}`}><Pencil /></button><button className="icon-btn danger" onClick={() => setDeleteTarget(product)} aria-label={`Eliminar ${product.name}`}><Trash2 /></button></div></div><div className="facts"><div><span>Compra</span><b>{product.purchasePriceUsd === null ? "—" : usd(product.purchasePriceUsd)}</b></div><div><span>Peso</span><b>{product.weightLb === null ? "—" : `${product.weightLb.toFixed(2)} lb`}</b></div><div className="green"><span>Venta GAM</span><b>{prices ? crc(prices.gamPriceCrc) : "Pendiente"}</b></div><div className="brown"><span>Venta Puerto</span><b>{prices ? crc(prices.puertoPriceCrc) : "Pendiente"}</b></div></div></article>; })}</div>{visibleCount < filteredProducts.length && <button className="btn secondary load-more" onClick={() => setVisibleCount((current) => current + 36)}>Mostrar más productos</button>}</>}
      </div>}

      {tab === "import" && <ImportView settings={settings} afterImport={() => void refreshProducts()} />}
      {tab === "settings" && <SettingsView key={JSON.stringify(settings)} current={settings} onSave={saveSettings} />}
    </div></div>
    <nav className="bottom">{nav.map(([id, label, Icon]) => <button className={tab === id ? "active" : ""} onClick={() => setTab(id)} key={id}><Icon />{label}</button>)}</nav><button className="float-scan" onPointerDown={() => void preloadScanner()} onClick={() => openScanner(tab === "products" ? (editingProductId !== null ? "assign" : "lookup-products") : "lookup-calculator")} aria-label="Escanear"><ScanLine /></button>
    {scannerIntent && <Scanner onClose={() => setScannerIntent(null)} onCode={handleScannerCode} />}
    {deleteTarget && <div className="modal" role="dialog" aria-modal="true" aria-label="Confirmar eliminación"><div className="confirm-card"><div className="delete-symbol"><Trash2 /></div><h2>¿Eliminar producto?</h2><p>Vas a eliminar <b>{deleteTarget.name}</b>. Esta acción no se puede deshacer.</p><div className="confirm-actions"><button className="btn secondary" onClick={() => setDeleteTarget(null)} disabled={deleting}>No, cancelar</button><button className="btn danger-solid" onClick={() => void removeProduct()} disabled={deleting}>{deleting ? <Loader2 className="spin" /> : <Trash2 />}Sí, eliminar</button></div></div></div>}
    {toast && <div className={`toast ${toast.type}`}>{toast.type === "success" ? <Check /> : <AlertCircle />}<span>{toast.text}</span><button onClick={() => setToast(null)}><X /></button></div>}
  </main>;
}
