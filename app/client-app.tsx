"use client";

import { AlertCircle, Calculator, Camera, Check, ChevronRight, CircleDollarSign, FileSpreadsheet, Info, Loader2, MapPin, Package, PackageSearch, Pencil, Plus, RotateCcw, Save, ScanLine, Search, Settings, Truck, Upload, Weight, X } from "lucide-react";
import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { calculatePrices, crc, DEFAULT_SETTINGS, hasCompletePricing, normalizeName, PricingSettings, ProductRecord, usd } from "@/lib/pricing";

type Tab = "calculator" | "products" | "import" | "settings";
type Form = { id: number | null; name: string; code: string; purchasePriceUsd: string; weightLb: string };
type Toast = { type: "success" | "error"; text: string } | null;
type Mapping = { name: string; purchasePriceUsd: string; weightLb: string; code: string };
const EMPTY: Form = { id: null, name: "", code: "", purchasePriceUsd: "", weightLb: "" };

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "Ocurrió un error inesperado.");
  return body;
}

function Scanner({ onClose, onCode }: { onClose: () => void; onCode: (value: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(true);
  useEffect(() => {
    let stopped = false; let controls: { stop: () => void } | undefined;
    (async () => {
      try {
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        if (!video.current || stopped) return;
        controls = await new BrowserMultiFormatReader().decodeFromVideoDevice(undefined, video.current, (result) => {
          if (result && !stopped) { controls?.stop(); onCode(result.getText()); }
        });
        if (!stopped) setStarting(false);
      } catch { if (!stopped) { setStarting(false); setError("No se pudo abrir la cámara. Revisá el permiso o ingresá el código manualmente."); } }
    })();
    return () => { stopped = true; controls?.stop(); };
  }, [onCode]);
  return <div className="modal" role="dialog" aria-modal="true" aria-label="Escáner de producto"><div className="scanner-card">
    <div className="modal-head"><div><span className="eyebrow">Cámara</span><h2>Escanear producto</h2></div><button className="icon-btn" onClick={onClose} aria-label="Cerrar"><X /></button></div>
    <div className="camera"><video ref={video} muted playsInline /><div className="scan-frame" />{starting && <div className="camera-state"><Loader2 className="spin" />Abriendo cámara…</div>}</div>
    {error ? <p className="alert error"><AlertCircle size={17} />{error}</p> : <p className="hint center">Colocá el QR o código de barras dentro del recuadro.</p>}
    <button className="btn secondary full" onClick={onClose}>Cancelar</button>
  </div></div>;
}

function Results({ price, weight, settings }: { price: number | null; weight: number | null; settings: PricingSettings }) {
  const complete = price !== null && Number.isFinite(price) && price >= 0 && weight !== null && Number.isFinite(weight) && weight >= 0;
  if (!complete) return <div className="results pending-results">
    <div className="price-card gam"><MapPin /><span>Precio de venta GAM</span><strong>—</strong></div>
    <div className="price-card port"><Truck /><span>Precio de venta Puerto</span><strong>—</strong></div>
    <p className="pending-note"><AlertCircle size={16} />Ingresá el precio de compra y el peso para calcular ambos precios.</p>
  </div>;
  const result = calculatePrices(price, weight, settings);
  return <div className="results">
    <div className="price-card gam"><MapPin /><span>Precio de venta GAM</span><strong>{crc(result.gamPriceCrc)}</strong></div>
    <div className="price-card port"><Truck /><span>Precio de venta Puerto</span><strong>{crc(result.puertoPriceCrc)}</strong></div>
    <details><summary>Ver desglose <ChevronRight size={18} /></summary><div className="breakdown">
      <div><span>Peso ingresado</span><b>{weight.toFixed(2)} lb</b></div><div><span>Peso cobrado (+{settings.extraWeightLb.toFixed(2)})</span><b>{result.chargedWeightLb.toFixed(2)} lb</b></div>
      <div><span>Courier</span><b>{usd(result.courierUsd)}</b></div><div><span>Compra + courier</span><b>{usd(result.merchandiseAndCourierUsd)}</b></div>
      <div><span>Entrega + Correos</span><b>{crc(settings.deliveryCrc + settings.correosCrc)}</b></div><div className="total"><span>Precio costo</span><b>{crc(result.costCrc)}</b></div>
    </div></details>
  </div>;
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
  const [fileName, setFileName] = useState(""); const [sheetName, setSheetName] = useState(""); const [firstDataRow, setFirstDataRow] = useState(2); const [headers, setHeaders] = useState<string[]>([]); const [rows, setRows] = useState<unknown[][]>([]);
  const [mapping, setMapping] = useState<Mapping>({ name: "", purchasePriceUsd: "", weightLb: "", code: "" });
  const [strategy, setStrategy] = useState<"update" | "skip">("update"); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState<Toast>(null);
  const mapped = useMemo(() => rows.map((row, i) => ({
    rowNumber: i + firstDataRow, name: mapping.name === "" ? "" : String(row[Number(mapping.name)] ?? "").trim(),
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
    const file = event.target.files?.[0]; if (!file) return; setBusy(true); setNotice(null);
    try {
      const XLSX = await import("xlsx"); const book = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const selectedSheet = book.SheetNames.find((name) => normalizeName(name) === "compu") || book.SheetNames[0];
      const data = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[selectedSheet], { header: 1, defval: "", raw: true });
      if (data.length < 2) throw new Error("El archivo no contiene productos.");
      const headerIndex = data.findIndex((row) => row.some((cell) => normalizeName(String(cell)) === "producto"));
      if (headerIndex < 0) throw new Error("No se encontró la columna Producto.");
      const nextHeaders = data[headerIndex].map((cell, i) => String(cell || `Columna ${i + 1}`).trim()); const normalized = nextHeaders.map(normalizeName);
      const find = (...tests: RegExp[]) => { const i = normalized.findIndex((head) => tests.some((test) => test.test(head))); return i < 0 ? "" : String(i); };
      setFileName(file.name); setSheetName(selectedSheet); setFirstDataRow(headerIndex + 2); setHeaders(nextHeaders); setRows(data.slice(headerIndex + 1).filter((row) => row.some((cell) => String(cell).trim())));
      setMapping({ name: find(/nombre/, /producto/, /descripcion/), purchasePriceUsd: find(/precio.*compra/, /precio.*producto/, /costo.*usd/, /^precio$/), weightLb: find(/peso/, /libras/, /^lb$/), code: find(/codigo/, /barra/, /barcode/, /^qr$/) });
    } catch (error) { setNotice({ type: "error", text: error instanceof Error ? error.message : "No se pudo leer el archivo." }); }
    finally { setBusy(false); event.target.value = ""; }
  }
  async function importRows() {
    setBusy(true); setNotice(null);
    try {
      const result = await json<{ imported: number; updated: number; skipped: number; errors: unknown[] }>(await fetch("/api/products/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: ready, strategy }) }));
      setNotice({ type: result.errors.length ? "error" : "success", text: `${result.imported} nuevos, ${result.updated} actualizados y ${result.skipped} omitidos.${result.errors.length ? ` ${result.errors.length} filas necesitan revisión.` : ""}` }); afterImport();
    } catch (error) { setNotice({ type: "error", text: error instanceof Error ? error.message : "No se pudo importar." }); } finally { setBusy(false); }
  }
  const reset = () => { setHeaders([]); setRows([]); setFileName(""); setSheetName(""); setNotice(null); };
  return <div className="view"><header className="view-head"><span className="eyebrow">Carga masiva</span><h1>Importar Excel</h1><p>Cargá tus productos y revisalos antes de guardar.</p></header>
    {!headers.length ? <section className="surface upload" onClick={() => input.current?.click()}><div className="upload-icon"><FileSpreadsheet /></div><h2>{busy ? "Leyendo archivo…" : "Seleccioná tu archivo"}</h2><p>.xlsx, .xlsm, .xls o .csv</p><button className="btn primary" disabled={busy}><Upload size={19} />Elegir archivo</button><input ref={input} type="file" accept=".xlsx,.xlsm,.xls,.csv" onChange={pick} hidden /></section> : <>
      <section className="surface file-row"><div><FileSpreadsheet /><span><b>{fileName}</b><small>Hoja {sheetName} · {named.length} filas con producto</small></span></div><button className="btn ghost small" onClick={reset}><RotateCcw size={16} />Cambiar</button></section>
      <section className="surface section"><Step n="1" title="Relacioná las columnas" text="Elegí qué columna corresponde a cada dato." /><div className="mapping">{([["name", "Nombre del producto", true], ["purchasePriceUsd", "Precio de compra USD", true], ["weightLb", "Peso en libras", true], ["code", "Código QR / barras", false]] as const).map(([key, label, required]) => <label className="field" key={key}><span>{label}{required && <em>*</em>}</span><select value={mapping[key]} onChange={(e) => setMapping({ ...mapping, [key]: e.target.value })}><option value="">Seleccionar columna</option>{headers.map((header, i) => <option value={i} key={`${header}-${i}`}>{header}</option>)}</select></label>)}</div></section>
      <section className="surface section"><Step n="2" title="Vista previa" text={complete ? `${ready.length} productos: ${pending.length} pendientes${duplicates ? ` · ${duplicates} repetidos resueltos con la última aparición` : ""}` : "Completá las columnas obligatorias."} /><div className="table-wrap"><table><thead><tr><th>Producto</th><th>Compra</th><th>Peso</th><th>GAM</th><th>Puerto</th><th>Estado</th></tr></thead><tbody>{ready.slice(0, 6).map((row) => {
        const ok = row.purchasePriceUsd !== null && row.purchasePriceUsd >= 0 && row.weightLb !== null && row.weightLb >= 0; const prices = ok ? calculatePrices(row.purchasePriceUsd, row.weightLb, settings) : null;
        return <tr key={row.rowNumber}><td><b>{row.name}</b>{row.code && <small>{row.code}</small>}</td><td>{row.purchasePriceUsd !== null ? usd(row.purchasePriceUsd) : "—"}</td><td>{row.weightLb !== null ? `${row.weightLb.toFixed(2)} lb` : "—"}</td><td>{prices ? crc(prices.gamPriceCrc) : "—"}</td><td>{prices ? crc(prices.puertoPriceCrc) : "—"}</td><td><span className={`pill ${ok ? "ok" : "bad"}`}>{ok ? <Check size={12} /> : <AlertCircle size={12} />}{ok ? "Lista" : "Pendiente"}</span></td></tr>;
      })}</tbody></table></div></section>
      <section className="surface section"><Step n="3" title="Productos ya guardados" text="Elegí qué hacer si el nombre o código ya existe en la app." /><div className="strategies"><label className={strategy === "update" ? "chosen" : ""}><input type="radio" checked={strategy === "update"} onChange={() => setStrategy("update")} /><span><b>Actualizar existentes</b><small>Reemplaza precio y peso.</small></span></label><label className={strategy === "skip" ? "chosen" : ""}><input type="radio" checked={strategy === "skip"} onChange={() => setStrategy("skip")} /><span><b>Omitir existentes</b><small>Conserva los datos guardados.</small></span></label></div><button className="btn primary full" disabled={!complete || !ready.length || busy} onClick={importRows}>{busy ? <Loader2 className="spin" /> : <Upload />}Importar {ready.length || ""} productos</button></section>
    </>}{notice && <p className={`alert ${notice.type}`}><AlertCircle size={17} />{notice.text}</p>}
  </div>;
}

function SettingsView({ current, onSave }: { current: PricingSettings; onSave: (value: PricingSettings) => Promise<void> }) {
  const [draft, setDraft] = useState(current); const [busy, setBusy] = useState(false);
  const fields: Array<[keyof PricingSettings, string, string, string, string]> = [
    ["exchangeRateCrc", "Tipo de cambio", "₡", "por $1", "1"], ["courierRateUsd", "Costo de courier", "$", "por lb", "0.01"], ["extraWeightLb", "Peso adicional", "", "lb", "0.01"], ["deliveryCrc", "Costo de entrega", "₡", "", "1"], ["correosCrc", "Correos de Costa Rica", "₡", "", "1"], ["gamProfitCrc", "Ganancia GAM", "₡", "", "1"], ["puertoProfitCrc", "Ganancia Puerto", "₡", "", "1"], ["roundingCrc", "Redondeo hacia arriba", "₡", "", "1"],
  ];
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); try { await onSave(draft); } finally { setBusy(false); } }
  return <div className="view"><header className="view-head"><span className="eyebrow">Valores generales</span><h1>Ajustes</h1><p>Los cambios recalculan todos los productos guardados.</p></header><form className="surface settings-form" onSubmit={submit}><div className="mapping">{fields.map(([key, label, prefix, suffix, step]) => <label className="field" key={key}><span>{label}</span><div className="number-box">{prefix && <i>{prefix}</i>}<input type="number" min="0" step={step} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })} />{suffix && <small>{suffix}</small>}</div></label>)}</div><div className="settings-note"><CircleDollarSign /><span>Se conservan el precio de compra y el peso; los precios de venta se actualizan con estos valores.</span></div><button className="btn primary full" disabled={busy}>{busy ? <Loader2 className="spin" /> : <Save />}Guardar ajustes</button></form></div>;
}

function Empty({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) { return <div className="empty">{icon}<h2>{title}</h2>{text && <p>{text}</p>}</div>; }

export function NutriPlusApp() {
  const [tab, setTab] = useState<Tab>("calculator"); const [settings, setSettings] = useState(DEFAULT_SETTINGS); const [form, setForm] = useState<Form>(EMPTY);
  const [products, setProducts] = useState<ProductRecord[]>([]); const [suggestions, setSuggestions] = useState<ProductRecord[]>([]); const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [query, setQuery] = useState(""); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [scanner, setScanner] = useState(false); const [toast, setToast] = useState<Toast>(null);
  const toastTimer = useRef<number | null>(null);
  const notify = (next: NonNullable<Toast>) => { setToast(next); if (toastTimer.current) window.clearTimeout(toastTimer.current); toastTimer.current = window.setTimeout(() => setToast(null), 3800); };
  async function fetchProducts(search = "") { const result = await json<{ products: ProductRecord[] }>(await fetch(`/api/products?q=${encodeURIComponent(search)}`)); setProducts(result.products); }

  useEffect(() => { (async () => { try { const [a, b] = await Promise.all([fetch("/api/settings"), fetch("/api/products")]); const settingsData = await json<{ settings: PricingSettings }>(a); const productsData = await json<{ products: ProductRecord[] }>(b); setSettings(settingsData.settings); setProducts(productsData.products); } catch (error) { notify({ type: "error", text: error instanceof Error ? error.message : "No se pudo iniciar la app." }); } finally { setLoading(false); } })(); }, []);
  useEffect(() => { const controller = new AbortController(); const timer = window.setTimeout(async () => { if (!form.name.trim()) { setSuggestions([]); return; } try { const result = await json<{ products: ProductRecord[] }>(await fetch(`/api/products?q=${encodeURIComponent(form.name)}&limit=8`, { signal: controller.signal })); setSuggestions(result.products.filter((product) => product.id !== form.id)); } catch { if (!controller.signal.aborted) setSuggestions([]); } }, 220); return () => { window.clearTimeout(timer); controller.abort(); }; }, [form.name, form.id]);
  useEffect(() => { if (tab !== "products") return; const controller = new AbortController(); const timer = window.setTimeout(async () => { setLoading(true); try { const result = await json<{ products: ProductRecord[] }>(await fetch(`/api/products?q=${encodeURIComponent(query)}`, { signal: controller.signal })); setProducts(result.products); } catch { /* replaced by newer query */ } finally { if (!controller.signal.aborted) setLoading(false); } }, 220); return () => { window.clearTimeout(timer); controller.abort(); }; }, [query, tab]);

  const loadProduct = (product: ProductRecord) => { setForm({ id: product.id, name: product.name, code: product.code || "", purchasePriceUsd: product.purchasePriceUsd === null ? "" : String(product.purchasePriceUsd), weightLb: product.weightLb === null ? "" : String(product.weightLb) }); setSuggestionsOpen(false); setTab("calculator"); };
  const price = form.purchasePriceUsd.trim() ? Number(form.purchasePriceUsd) : null;
  const weight = form.weightLb.trim() ? Number(form.weightLb) : null;
  const validPrice = price === null || (Number.isFinite(price) && price >= 0);
  const validWeight = weight === null || (Number.isFinite(weight) && weight >= 0);
  const completePricing = price !== null && validPrice && weight !== null && validWeight;
  const validForm = Boolean(form.name.trim()) && validPrice && validWeight;
  async function save(event: FormEvent) { event.preventDefault(); if (!form.name.trim()) return notify({ type: "error", text: "El nombre del producto es obligatorio." }); setSaving(true); try { const data = await json<{ product: ProductRecord }>(await fetch(form.id ? `/api/products/${form.id}` : "/api/products", { method: form.id ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, purchasePriceUsd: price, weightLb: weight }) })); const editing = Boolean(form.id); loadProduct(data.product); notify({ type: "success", text: editing ? "Producto actualizado." : completePricing ? "Cotización guardada." : "Producto guardado como pendiente." }); await fetchProducts(query); } catch (error) { notify({ type: "error", text: error instanceof Error ? error.message : "No se pudo guardar." }); } finally { setSaving(false); } }
  async function scanned(code: string) { setScanner(false); try { const data = await json<{ product: ProductRecord | null }>(await fetch(`/api/products?code=${encodeURIComponent(code)}`)); if (data.product) { loadProduct(data.product); notify({ type: "success", text: `Encontramos ${data.product.name}.` }); } else { setForm((current) => ({ ...current, code })); setTab("calculator"); notify({ type: "success", text: "Código nuevo. Completá los datos para guardarlo." }); } } catch (error) { notify({ type: "error", text: error instanceof Error ? error.message : "No se pudo buscar el código." }); } }
  async function saveSettings(next: PricingSettings) { try { const data = await json<{ settings: PricingSettings }>(await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) })); setSettings(data.settings); notify({ type: "success", text: "Ajustes guardados. Todos los precios fueron recalculados." }); } catch (error) { notify({ type: "error", text: error instanceof Error ? error.message : "No se pudieron guardar." }); throw error; } }

  const nav: Array<[Tab, string, typeof Calculator]> = [["calculator", "Calcular", Calculator], ["products", "Productos", PackageSearch], ["import", "Importar", FileSpreadsheet], ["settings", "Ajustes", Settings]];
  if (loading && !products.length && tab === "calculator") return <main className="loading"><span className="brand-mark">N+</span><Loader2 className="spin" />Preparando NutriPlus…</main>;
  return <main className="app-shell"><header className="topbar"><div><button className="brand" onClick={() => setTab("calculator")}><span className="brand-mark">N+</span><span><b>NutriPlus</b><small>Calculadora de precios</small></span></button><div className="rate"><small>Tipo de cambio</small><b>₡{settings.exchangeRateCrc}</b></div></div></header>
    <div className="body"><aside className="side"><span>Menú</span>{nav.map(([id, label, Icon]) => <button className={tab === id ? "active" : ""} onClick={() => setTab(id)} key={id}><Icon />{label}</button>)}<div className="weight-note"><Weight /><span><b>+{settings.extraWeightLb.toFixed(2)} lb</b><small>en cada cálculo</small></span></div></aside><div className="content">
      {tab === "calculator" && <div className="view"><header className="view-head row"><div><span className="eyebrow">Cotización rápida</span><h1>{form.id ? "Actualizar producto" : "Calcular precio"}</h1><p>Los precios cambian al instante mientras escribís.</p></div>{form.id && <button className="btn ghost small" onClick={() => setForm(EMPTY)}><Plus size={17} />Nuevo</button>}</header><form className="calculator" onSubmit={save}><section className="surface form-card">{form.id && <div className="edit-banner"><Pencil size={15} />Editando producto guardado</div>}
        <label className="field name-field"><span>Nombre del producto <em>*</em></span><div className="input-icon"><Package /><input value={form.name} onChange={(e) => { setForm({ ...form, name: e.target.value }); setSuggestionsOpen(true); }} onFocus={() => setSuggestionsOpen(true)} onBlur={() => window.setTimeout(() => setSuggestionsOpen(false), 160)} placeholder="Ej. Magnesio glicinato" required /></div>{suggestionsOpen && form.name.trim() && suggestions.length > 0 && <div className="suggestions"><small>Productos encontrados</small>{suggestions.slice(0, 6).map((product) => <button type="button" onMouseDown={() => loadProduct(product)} key={product.id}><b>{product.name}</b><span>{product.purchasePriceUsd === null ? "Compra pendiente" : usd(product.purchasePriceUsd)} · {product.weightLb === null ? "peso pendiente" : `${product.weightLb.toFixed(2)} lb`}</span></button>)}</div>}<p className="hint">Escribí para comprobar si ya está guardado.</p></label>
        <label className="field"><span>Código QR o de barras <small>Opcional</small></span><div className="code-row"><div className="input-icon grow"><ScanLine /><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="Escaneá o escribí el código" inputMode="numeric" /></div><button type="button" className="scan-btn" onClick={() => setScanner(true)}><Camera /><span>Escanear</span></button></div></label>
        <div className="two"><label className="field"><span>Precio de compra</span><div className="number-box"><i>$</i><input type="number" min="0" step="0.01" value={form.purchasePriceUsd} onChange={(e) => setForm({ ...form, purchasePriceUsd: e.target.value })} placeholder="Pendiente" /></div><p className="hint">En dólares</p></label><label className="field"><span>Peso</span><div className="number-box"><input type="number" min="0" step="0.001" value={form.weightLb} onChange={(e) => setForm({ ...form, weightLb: e.target.value })} placeholder="Pendiente" /><small>lb</small></div><p className="hint">Se suman {settings.extraWeightLb.toFixed(2)} lb.</p></label></div>
        {!form.name.trim() && (form.purchasePriceUsd || form.weightLb) && <p className="alert warning"><AlertCircle size={17} />Agregá el nombre para guardar.</p>}{form.name.trim() && !completePricing && <p className="alert warning"><AlertCircle size={17} />Podés guardarlo como pendiente y completar los datos después.</p>}<button className="btn primary full" disabled={!validForm || saving}>{saving ? <Loader2 className="spin" /> : <Save />}{completePricing ? (form.id ? "Guardar cambios" : "Guardar cotización") : "Guardar pendiente"}</button>
      </section><div className="result-col"><Results price={validPrice ? price : null} weight={validWeight ? weight : null} settings={settings} /><p className="formula-note"><Info />Tipo de cambio <b>₡{settings.exchangeRateCrc}</b> · Courier <b>{usd(settings.courierRateUsd)}/lb</b></p></div></form></div>}
      {tab === "products" && <div className="view"><header className="view-head"><span className="eyebrow">Historial guardado</span><h1>Productos</h1><p>Buscá por nombre, QR o código de barras.</p></header><section className="surface search-card"><div className="input-icon grow"><Search /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar producto…" /></div><button className="scan-btn" onClick={() => setScanner(true)}><Camera /><span>Escanear</span></button></section>{loading ? <Empty icon={<Loader2 className="spin" />} title="Buscando…" text="" /> : !products.length ? <Empty icon={<PackageSearch />} title={query ? "No hay coincidencias" : "Todavía no hay productos"} text={query ? "Probá con otro nombre o escaneá el código." : "Las cotizaciones guardadas aparecerán aquí."} /> : <div className="product-grid">{products.map((product) => { const complete = hasCompletePricing(product); const prices = complete ? calculatePrices(product.purchasePriceUsd, product.weightLb, settings) : null; return <article className={`product-card ${complete ? "" : "pending-product"}`} key={product.id}><div className="product-title"><span className="avatar">{product.name[0].toUpperCase()}</span><div><h2>{product.name}</h2>{product.code ? <small><ScanLine size={12} />{product.code}</small> : !complete && <small className="pending-label"><AlertCircle size={12} />Pendiente</small>}</div><button className="icon-btn" onClick={() => loadProduct(product)}><Pencil size={17} /></button></div><div className="facts"><div><span>Compra</span><b>{product.purchasePriceUsd === null ? "—" : usd(product.purchasePriceUsd)}</b></div><div><span>Peso</span><b>{product.weightLb === null ? "—" : `${product.weightLb.toFixed(2)} lb`}</b></div><div className="green"><span>Venta GAM</span><b>{prices ? crc(prices.gamPriceCrc) : "Pendiente"}</b></div><div className="brown"><span>Venta Puerto</span><b>{prices ? crc(prices.puertoPriceCrc) : "Pendiente"}</b></div></div><button className="edit-link" onClick={() => loadProduct(product)}>{complete ? "Actualizar precio o peso" : "Completar precio o peso"} <ChevronRight size={16} /></button></article>; })}</div>}</div>}
      {tab === "import" && <ImportView settings={settings} afterImport={() => void fetchProducts(query)} />}{tab === "settings" && <SettingsView key={JSON.stringify(settings)} current={settings} onSave={saveSettings} />}
    </div></div>
    <nav className="bottom">{nav.map(([id, label, Icon]) => <button className={tab === id ? "active" : ""} onClick={() => setTab(id)} key={id}><Icon />{label}</button>)}</nav><button className="float-scan" onClick={() => setScanner(true)} aria-label="Escanear"><ScanLine /></button>
    {scanner && <Scanner onClose={() => setScanner(false)} onCode={scanned} />}{toast && <div className={`toast ${toast.type}`}>{toast.type === "success" ? <Check /> : <AlertCircle />}<span>{toast.text}</span><button onClick={() => setToast(null)}><X /></button></div>}
  </main>;
}
