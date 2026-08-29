import ExcelJS from "exceljs";
import { pdfBoldFontUrl, pdfRegularFontUrl } from "./pdf-fonts";

type FinanceSnapshot = Awaited<ReturnType<typeof import("./finance").loadFinanceSnapshot>>;

function crc(value: number | null) {
  if (value == null) return "Costo histórico no disponible";
  const rounded = Math.round(value);
  return `${rounded < 0 ? "-" : ""}₡${new Intl.NumberFormat("es-CR", { maximumFractionDigits: 0 }).format(Math.abs(rounded))}`;
}

function safe(value: unknown) {
  return String(value ?? "").replace(/[‐‑‒–—―]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
}

function styleSheet(sheet: ExcelJS.Worksheet) {
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF285E3F" } };
  sheet.columns.forEach((column) => { column.width = Math.min(45, Math.max(12, Number(column.width || 12))); });
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, sheet.columnCount) } };
}

export async function createFinanceExcel(snapshot: FinanceSnapshot) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "NutriPlus Supplements";
  workbook.created = new Date(snapshot.generatedAt);
  const summary = workbook.addWorksheet("Resumen");
  summary.addRow(["Indicador", "Valor", "Origen"]);
  summary.addRows([
    ["Ventas", snapshot.metrics.sales, "Pedidos DELIVERED"],
    ["Ganancia neta", snapshot.metrics.netProfit, snapshot.metrics.costsComplete ? "Ventas - COGS - gastos operativos" : "Costo histórico incompleto"],
    ["Gastos operativos", snapshot.metrics.operatingExpenses, "Gastos de negocio, sin compras de inventario"],
    ["Flujo neto de caja", snapshot.metrics.cashNet, "Cobros - salidas pagadas"],
    ["Ganancia bruta", snapshot.metrics.grossProfit, snapshot.metrics.costsComplete ? "Ingreso productos - COGS" : "Costo histórico incompleto"],
    ["COGS", snapshot.metrics.cogs, snapshot.metrics.costsComplete ? "Snapshots históricos" : "Costo histórico incompleto"],
    ["Ingresos por envío", snapshot.metrics.deliveryIncome, "Pedidos DELIVERED"],
  ]);
  styleSheet(summary);
  ["B", "C"].forEach((column) => { summary.getColumn(column).width = 30; });
  summary.getColumn("B").numFmt = '₡#,##0;[Red]-₡#,##0';

  const sales = workbook.addWorksheet("Ventas");
  sales.addRow(["NP", "Cliente", "Entrega", "Productos bruto", "Descuento", "Productos neto", "Envío", "Total", "COGS", "Ganancia bruta", "Ruta"]);
  snapshot.sales.forEach((sale) => sales.addRow([sale.orderNumber, sale.customerName, sale.deliveredDate, sale.productGross, sale.discount, sale.productNet, sale.deliveryIncome, sale.totalIncome, sale.cogs, sale.grossProfit, sale.routeId || ""]));
  styleSheet(sales);
  [4, 5, 6, 7, 8, 9, 10].forEach((column) => { sales.getColumn(column).numFmt = '₡#,##0;[Red]-₡#,##0'; });

  const expenses = workbook.addWorksheet("Gastos");
  expenses.addRow(["Fecha", "Categoría", "Descripción", "Monto CRC", "Moneda", "Método", "Proveedor", "Ruta", "Pedido", "Origen", "Tipo", "Incluye NutriPlus"]);
  snapshot.expenses.forEach((item) => expenses.addRow([item.date, item.categoryLabel, item.description, item.entryType === "REVERSAL" ? -item.amountCrc : item.amountCrc, item.currency, item.paymentMethod, item.provider || "", item.routeId || "", item.orderId || "", item.sourceType, item.entryType, item.businessScope === "BUSINESS" ? "Sí" : "No"]));
  styleSheet(expenses);
  expenses.getColumn(4).numFmt = '₡#,##0;[Red]-₡#,##0';

  const cash = workbook.addWorksheet("Caja");
  cash.addRow(["Fecha", "Tipo", "Referencia", "Método", "Entrada", "Salida"]);
  snapshot.cash.payments.forEach((item) => cash.addRow([item.createdAt, "Cobro", `${item.orderNumber} · ${item.customerName}`, item.method, Math.max(0, item.signedAmount), Math.max(0, -item.signedAmount)]));
  snapshot.cash.expenses.forEach((item) => cash.addRow([item.date, item.entryType === "REVERSAL" ? "Reversa gasto" : "Gasto", item.description, item.paymentMethod, item.entryType === "REVERSAL" ? item.amountCrc : 0, item.entryType === "EXPENSE" ? item.amountCrc : 0]));
  styleSheet(cash);
  cash.getColumn(5).numFmt = cash.getColumn(6).numFmt = '₡#,##0;[Red]-₡#,##0';

  const profitability = workbook.addWorksheet("Rentabilidad");
  profitability.addRow(["Nivel", "Referencia", "Unidades", "Ingreso", "COGS", "Gasto directo", "Resultado", "Margen %"]);
  snapshot.profitability.products.forEach((item) => profitability.addRow(["Producto", item.name, item.units, item.income, item.cogs, 0, item.profit, item.marginPercent]));
  snapshot.profitability.orders.forEach((item) => profitability.addRow(["Pedido", `${item.orderNumber} · ${item.customerName}`, "", item.productNet + item.deliveryIncome, item.cogs, item.directExpenses, item.result, ""]));
  snapshot.profitability.routes.forEach((item) => profitability.addRow(["Ruta", `${item.date} · ${item.label}`, "", item.products + item.delivery, item.cogs, item.expenses, item.result, ""]));
  styleSheet(profitability);
  [4, 5, 6, 7].forEach((column) => { profitability.getColumn(column).numFmt = '₡#,##0;[Red]-₡#,##0'; });
  profitability.getColumn(8).numFmt = '0.0"%"';

  const receivables = workbook.addWorksheet("Cuentas por cobrar");
  receivables.addRow(["NP", "Cliente", "Entrega", "Total", "Abonado", "Saldo", "Antigüedad días"]);
  snapshot.receivables.forEach((item) => receivables.addRow([item.orderNumber, item.customerName, item.deliveredDate, item.totalIncome, item.paidTotal, item.balance, item.ageDays]));
  styleSheet(receivables);
  [4, 5, 6].forEach((column) => { receivables.getColumn(column).numFmt = '₡#,##0;[Red]-₡#,##0'; });
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

export async function createFinancePdf(snapshot: FinanceSnapshot) {
  const [{ PDFDocument, rgb }, fontkitModule] = await Promise.all([import("pdf-lib"), import("@pdf-lib/fontkit")]);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkitModule.default);
  pdf.setTitle(`Finanzas NutriPlus ${snapshot.range.from} a ${snapshot.range.to}`);
  pdf.setAuthor("NutriPlus Supplements");
  pdf.setSubject("Ventas, gastos, caja y rentabilidad trazable");
  const [regularResponse, boldResponse] = await Promise.all([fetch(pdfRegularFontUrl), fetch(pdfBoldFontUrl)]);
  if (!regularResponse.ok || !boldResponse.ok) throw new Error("No se pudo preparar la tipografía del reporte financiero.");
  const [regularBytes, boldBytes] = await Promise.all([regularResponse.arrayBuffer(), boldResponse.arrayBuffer()]);
  const regular = await pdf.embedFont(regularBytes, { subset: true });
  const bold = await pdf.embedFont(boldBytes, { subset: true });
  const colors = { green: rgb(40 / 255, 94 / 255, 63 / 255), ink: rgb(35 / 255, 46 / 255, 38 / 255), muted: rgb(100 / 255, 110 / 255, 102 / 255), line: rgb(220 / 255, 228 / 255, 219 / 255), white: rgb(1, 1, 1) };
  let page = pdf.addPage([595.28, 841.89]);
  let y = 790;
  const newPage = () => {
    page = pdf.addPage([595.28, 841.89]);
    page.drawRectangle({ x: 0, y: 792, width: 595.28, height: 50, color: colors.green });
    page.drawText("NUTRIPLUS · VENTAS Y GASTOS · CONTINUACIÓN", { x: 35, y: 815, size: 11, font: bold, color: colors.white });
    page.drawText(`${snapshot.range.from} a ${snapshot.range.to}`, { x: 35, y: 800, size: 7.5, font: regular, color: colors.white });
    y = 760;
  };
  const line = (label: string, value = "", heading = false) => {
    if (y < (heading ? 88 : 55)) newPage();
    if (heading) {
      page.drawRectangle({ x: 35, y: y - 6, width: 525, height: 23, color: colors.green });
      page.drawText(safe(label), { x: 44, y: y + 1, size: 10, font: bold, color: colors.white });
      y -= 32;
      return;
    }
    page.drawText(safe(label).slice(0, 62), { x: 42, y, size: 8.3, font: regular, color: colors.ink });
    const rendered = safe(value).slice(0, 45);
    const width = bold.widthOfTextAtSize(rendered, 8.3);
    page.drawText(rendered, { x: 550 - width, y, size: 8.3, font: bold, color: colors.ink });
    page.drawLine({ start: { x: 42, y: y - 5 }, end: { x: 550, y: y - 5 }, thickness: .35, color: colors.line });
    y -= 18;
  };
  page.drawRectangle({ x: 0, y: 772, width: 595.28, height: 70, color: colors.green });
  page.drawText("NUTRIPLUS · VENTAS Y GASTOS", { x: 35, y: 812, size: 15, font: bold, color: colors.white });
  page.drawText(`${snapshot.range.from} a ${snapshot.range.to}`, { x: 35, y: 790, size: 9, font: regular, color: colors.white });
  y = 748;
  line("Resumen", "", true);
  line("Ventas", crc(snapshot.metrics.sales));
  line("Ganancia neta", crc(snapshot.metrics.netProfit));
  line("Gastos operativos", crc(snapshot.metrics.operatingExpenses));
  line("Flujo neto de caja", crc(snapshot.metrics.cashNet));
  line("Ganancia bruta", crc(snapshot.metrics.grossProfit));
  line("Costo de productos vendidos", crc(snapshot.metrics.cogs));
  line("Ingresos por envío", crc(snapshot.metrics.deliveryIncome));
  line("Pedidos entregados", String(snapshot.metrics.deliveredOrders));
  line("Ventas entregadas", "", true);
  snapshot.sales.forEach((sale) => line(`${sale.orderNumber} · ${sale.customerName} · ${sale.deliveredDate}`, `${crc(sale.totalIncome)} · COGS ${crc(sale.cogs)}`));
  line("Gastos", "", true);
  snapshot.expenses.forEach((item) => line(`${item.businessScope === "PERSONAL" ? "EXCLUIDO · " : ""}${item.date} · ${item.categoryLabel} · ${item.description}`, `${item.entryType === "REVERSAL" ? "+" : "-"}${crc(item.amountCrc)}`));
  line("Caja", "", true);
  line("Entradas", crc(snapshot.cash.incoming));
  line("Salidas", crc(snapshot.cash.outgoing));
  line("Flujo neto", crc(snapshot.cash.net));
  line("Cuentas por cobrar", "", true);
  snapshot.receivables.forEach((item) => line(`${item.orderNumber} · ${item.customerName} · ${item.ageDays} días`, crc(item.balance)));
  line("Rentabilidad por producto", "", true);
  snapshot.profitability.products.forEach((item) => line(`${item.name} · ${item.units} unidad${item.units === 1 ? "" : "es"}`, item.profit == null ? "Costo histórico no disponible" : crc(item.profit)));
  line("Rentabilidad por pedido", "", true);
  snapshot.profitability.orders.forEach((item) => line(`${item.orderNumber} · gasto directo ${crc(item.directExpenses)}`, crc(item.result)));
  line("Rentabilidad por ruta", "", true);
  snapshot.profitability.routes.forEach((item) => line(`${item.date} · ${item.label} · gasto directo ${crc(item.expenses)}`, crc(item.result)));
  const pages = pdf.getPages();
  pages.forEach((target, index) => target.drawText(`NutriPlus · ${index + 1}/${pages.length}`, { x: 455, y: 24, size: 7, font: regular, color: colors.muted }));
  return pdf.save();
}
