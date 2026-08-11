import type { NonInventoryRecord, PricingSettings, ProductRecord } from "./pricing";
import { calculatePrices, hasCompletePricing } from "./pricing";
import pdfBoldFontUrl from "dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf?url";
import pdfRegularFontUrl from "dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url";

type InventoryRow = {
  product: ProductRecord | NonInventoryRecord;
  inventory: boolean;
  purchasePriceUsd: number | null;
  weightLb: number | null;
  chargedWeightLb: number | null;
  courierUsd: number | null;
  costCrc: number | null;
  gamPriceCrc: number | null;
  puertoPriceCrc: number | null;
};

const GREEN = "285E3F";
const GREEN_DARK = "193B2B";
const GREEN_LIGHT = "E7F2E6";
const AMBER = "9A6A19";
const AMBER_LIGHT = "FFF4D8";
const RED_LIGHT = "FBECEB";
const INK = "293229";
const MUTED = "6C776D";
const LINE = "DDE5DB";

function toInventoryRow(product: ProductRecord, settings: PricingSettings): InventoryRow {
  if (!hasCompletePricing(product)) {
    return {
      product,
      inventory: true,
      purchasePriceUsd: product.purchasePriceUsd,
      weightLb: product.weightLb,
      chargedWeightLb: null,
      courierUsd: null,
      costCrc: null,
      gamPriceCrc: null,
      puertoPriceCrc: null,
    };
  }
  const prices = calculatePrices(product.purchasePriceUsd, product.weightLb, settings);
  return {
    product,
    inventory: true,
    purchasePriceUsd: product.purchasePriceUsd,
    weightLb: product.weightLb,
    chargedWeightLb: prices.chargedWeightLb,
    courierUsd: prices.courierUsd,
    costCrc: prices.costCrc,
    gamPriceCrc: prices.gamPriceCrc,
    puertoPriceCrc: prices.puertoPriceCrc,
  };
}

function toNonInventoryRow(product: NonInventoryRecord, settings: PricingSettings): InventoryRow {
  if (!hasCompletePricing(product)) {
    return { product, inventory: false, purchasePriceUsd: product.purchasePriceUsd, weightLb: product.weightLb, chargedWeightLb: null, courierUsd: null, costCrc: null, gamPriceCrc: null, puertoPriceCrc: null };
  }
  const prices = calculatePrices(product.purchasePriceUsd, product.weightLb, settings);
  return { product, inventory: false, purchasePriceUsd: product.purchasePriceUsd, weightLb: product.weightLb, chargedWeightLb: prices.chargedWeightLb, courierUsd: prices.courierUsd, costCrc: prices.costCrc, gamPriceCrc: prices.gamPriceCrc, puertoPriceCrc: prices.puertoPriceCrc };
}

function parseUpdatedAt(value: string) {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function dateStamp(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateText(date: Date) {
  return new Intl.DateTimeFormat("es-CR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function createExcel(
  complete: InventoryRow[],
  incomplete: InventoryRow[],
  noInventory: InventoryRow[],
  generatedAt: Date,
  extraWeightLb: number,
) {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "NutriPlus Supplements";
  workbook.created = generatedAt;
  workbook.modified = generatedAt;
  workbook.title = "Inventario NutriPlus";
  workbook.subject = "Catálogo de precios e inventario";
  workbook.company = "NutriPlus Supplements";

  const headers = [
    "Producto",
    "Código de barras",
    "Precio de compra ($)",
    "Peso ingresado (lb)",
    `Peso calculado (+${extraWeightLb.toFixed(2)} lb)`,
    "Costo del courier ($)",
    "Precio costo (₡)",
    "Precio GAM (₡)",
    "Precio Puerto (₡)",
    "Cantidad disponible",
    "Stock mínimo",
    "Fecha de actualización",
  ];
  const widths = [44, 22, 19, 18, 22, 21, 18, 18, 19, 19, 15, 22];

  function addSheet(name: string, title: string, rows: InventoryRow[], incompleteSheet: boolean, noInventorySheet = false) {
    const sheet = workbook.addWorksheet(name, {
      properties: { tabColor: { argb: incompleteSheet ? AMBER : GREEN } },
      views: [{ state: "frozen", xSplit: 2, ySplit: 4, showGridLines: false }],
      pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
    });
    sheet.mergeCells("A1:L1");
    sheet.getCell("A1").value = title;
    sheet.getCell("A1").font = { name: "Arial", size: 18, bold: true, color: { argb: "FFFFFF" } };
    sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: incompleteSheet ? AMBER : GREEN_DARK } };
    sheet.getCell("A1").alignment = { vertical: "middle", horizontal: "left" };
    sheet.getRow(1).height = 34;

    sheet.mergeCells("A2:L2");
    sheet.getCell("A2").value = `${rows.length} productos · Generado el ${dateText(generatedAt)}${noInventorySheet ? " · Cotizaciones que no forman parte del inventario." : " · Los productos incompletos no muestran precios calculados."}`;
    sheet.getCell("A2").font = { name: "Arial", size: 10, color: { argb: MUTED } };
    sheet.getCell("A2").fill = { type: "pattern", pattern: "solid", fgColor: { argb: incompleteSheet ? AMBER_LIGHT : GREEN_LIGHT } };
    sheet.getCell("A2").alignment = { vertical: "middle", horizontal: "left" };
    sheet.getRow(2).height = 24;
    sheet.getRow(3).height = 8;

    const header = sheet.getRow(4);
    header.values = headers;
    header.height = 34;
    header.eachCell((cell) => {
      cell.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: incompleteSheet ? AMBER : GREEN } };
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      cell.border = { bottom: { style: "medium", color: { argb: incompleteSheet ? AMBER : GREEN_DARK } } };
    });

    sheet.columns.forEach((column, index) => { column.width = widths[index]; });
    rows.forEach((item, index) => {
      const product = item.product;
      const row = sheet.getRow(index + 5);
      row.values = [
        product.name,
        product.code || null,
        item.purchasePriceUsd,
        item.weightLb,
        item.chargedWeightLb,
        item.courierUsd,
        item.costCrc,
        item.gamPriceCrc,
        item.puertoPriceCrc,
        item.inventory ? (product as ProductRecord).quantityAvailable : null,
        item.inventory && (product as ProductRecord).minimumStockEnabled ? (product as ProductRecord).minimumStock : null,
        parseUpdatedAt(product.updatedAt),
      ];
      const nameLines = Math.max(1, Math.ceil(product.name.length / 52));
      const codeLines = Math.max(1, Math.ceil((product.code || "").length / 25));
      row.height = Math.max(27, Math.max(nameLines, codeLines) * 13 + 8);
      row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
        cell.font = { name: "Arial", size: 9.5, color: { argb: INK } };
        cell.alignment = { vertical: "middle", horizontal: columnNumber <= 2 ? "left" : "right", wrapText: columnNumber <= 2 };
        cell.border = { bottom: { style: "thin", color: { argb: LINE } } };
        if (index % 2 === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: incompleteSheet ? "FFFBF0" : "F7FAF5" } };
      });
      row.getCell(3).numFmt = '"$"#,##0.00';
      row.getCell(4).numFmt = "0.00";
      row.getCell(5).numFmt = "0.00";
      row.getCell(6).numFmt = '"$"#,##0.00';
      row.getCell(7).numFmt = '"₡"#,##0';
      row.getCell(8).numFmt = '"₡"#,##0';
      row.getCell(9).numFmt = '"₡"#,##0';
      row.getCell(10).numFmt = "0";
      row.getCell(11).numFmt = "0";
      row.getCell(12).numFmt = "dd/mm/yyyy hh:mm";
    });

    const lastRow = Math.max(4, rows.length + 4);
    sheet.autoFilter = { from: "A4", to: `L${lastRow}` };
    if (rows.length) {
      if (!noInventorySheet) sheet.addConditionalFormatting({
        ref: `A5:L${lastRow}`,
        rules: [{
          type: "expression",
          priority: 1,
          formulae: ["AND(ISNUMBER($K5),$J5<=$K5)"],
          style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: RED_LIGHT }, fgColor: { argb: RED_LIGHT } } },
        }],
      });
    }
    sheet.headerFooter.oddFooter = "NutriPlus Supplements · Página &P de &N";
    return sheet;
  }

  addSheet("Productos completos", "Inventario NutriPlus - Productos completos", complete, false);
  addSheet("Productos incompletos", "Inventario NutriPlus - Productos incompletos", incomplete, true);
  addSheet("No inventario", "NutriPlus - No inventario", noInventory, false, true);
  return workbook.xlsx.writeBuffer();
}

function pdfSafe(value: string) {
  return value
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\u00a0/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function money(value: number | null, decimals = 0) {
  if (value === null) return "-";
  return new Intl.NumberFormat("es-CR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
}

async function createPdf(complete: InventoryRow[], incomplete: InventoryRow[], noInventory: InventoryRow[], generatedAt: Date, extraWeightLb: number) {
  const [{ PDFDocument, rgb }, fontkitModule] = await Promise.all([import("pdf-lib"), import("@pdf-lib/fontkit")]);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkitModule.default);
  pdf.setTitle("Inventario NutriPlus");
  pdf.setAuthor("NutriPlus Supplements");
  pdf.setSubject("Catálogo de precios e inventario");
  pdf.setCreationDate(generatedAt);
  pdf.setModificationDate(generatedAt);
  const [regularResponse, boldResponse] = await Promise.all([fetch(pdfRegularFontUrl), fetch(pdfBoldFontUrl)]);
  if (!regularResponse.ok || !boldResponse.ok) throw new Error("No se pudo preparar la tipografía del PDF.");
  const [regularBytes, boldBytes] = await Promise.all([regularResponse.arrayBuffer(), boldResponse.arrayBuffer()]);
  const regular = await pdf.embedFont(regularBytes, { subset: true });
  const bold = await pdf.embedFont(boldBytes, { subset: true });
  const pageSize: [number, number] = [841.89, 595.28];
  const margin = 28;
  const widths = [190, 82, 50, 40, 46, 45, 60, 55, 55, 40, 40, 70];
  const headers = ["Producto", "Código", "Compra ($)", "Peso (lb)", `Peso +${extraWeightLb.toFixed(2)}`, "Courier ($)", "Costo (CRC)", "GAM (CRC)", "Puerto (CRC)", "Cantidad", "Mínimo", "Actualizado"];
  const colors = {
    green: rgb(40 / 255, 94 / 255, 63 / 255),
    greenDark: rgb(25 / 255, 59 / 255, 43 / 255),
    greenLight: rgb(231 / 255, 242 / 255, 230 / 255),
    amber: rgb(154 / 255, 106 / 255, 25 / 255),
    amberLight: rgb(1, 244 / 255, 216 / 255),
    redLight: rgb(251 / 255, 236 / 255, 235 / 255),
    ink: rgb(41 / 255, 50 / 255, 41 / 255),
    muted: rgb(108 / 255, 119 / 255, 109 / 255),
    line: rgb(221 / 255, 229 / 255, 219 / 255),
    white: rgb(1, 1, 1),
  };

  function wrap(value: string, width: number, size: number, maxLines = 2) {
    const text = pdfSafe(value) || "-";
    const lines: string[] = [];
    let current = "";
    let consumed = 0;
    for (const character of text) {
      const attempt = `${current}${character}`;
      if (!current || regular.widthOfTextAtSize(attempt, size) <= width) {
        current = attempt;
        consumed += 1;
        continue;
      }
      const split = current.lastIndexOf(" ");
      if (split > 0) {
        lines.push(current.slice(0, split));
        current = `${current.slice(split + 1)}${character}`;
      } else {
        lines.push(current);
        current = character === " " ? "" : character;
      }
      consumed += 1;
      if (lines.length >= maxLines) break;
    }
    if (current && lines.length < maxLines) lines.push(current);
    if (Number.isFinite(maxLines) && lines.length === maxLines && consumed < text.length) {
      let last = lines[maxLines - 1];
      while (last.length && regular.widthOfTextAtSize(`${last}...`, size) > width) last = last.slice(0, -1);
      lines[maxLines - 1] = `${last.trim()}...`;
    }
    return lines.length ? lines : ["-"];
  }

  function addPage(section: string, incompleteSection: boolean, firstInSection: boolean) {
    const page = pdf.addPage(pageSize);
    const [pageWidth, pageHeight] = pageSize;
    const accent = incompleteSection ? colors.amber : colors.greenDark;
    page.drawRectangle({ x: 0, y: pageHeight - 54, width: pageWidth, height: 54, color: accent });
    page.drawText("NutriPlus Supplements", { x: margin, y: pageHeight - 25, size: 13, font: bold, color: colors.white });
    page.drawText(pdfSafe(section), { x: margin, y: pageHeight - 43, size: 8.5, font: regular, color: colors.white });
    page.drawText(`Generado: ${dateText(generatedAt)}`, { x: pageWidth - margin - 112, y: pageHeight - 32, size: 7.5, font: regular, color: colors.white });
    let y = pageHeight - 70;
    if (firstInSection) {
      page.drawText(pdfSafe(section), { x: margin, y, size: 15, font: bold, color: accent });
      y -= 17;
      page.drawText("Los precios se muestran con los ajustes vigentes al momento de la descarga.", { x: margin, y, size: 7.5, font: regular, color: colors.muted });
      y -= 14;
    }
    const headerHeight = 26;
    let x = margin;
    headers.forEach((header, index) => {
      page.drawRectangle({ x, y: y - headerHeight, width: widths[index], height: headerHeight, color: incompleteSection ? colors.amber : colors.green });
      const lines = wrap(header, widths[index] - 6, 6.4, 2);
      lines.forEach((line, lineIndex) => page.drawText(line, { x: x + 3, y: y - 10 - lineIndex * 7, size: 6.4, font: bold, color: colors.white }));
      x += widths[index];
    });
    return { page, y: y - headerHeight };
  }

  function rowValues(item: InventoryRow) {
    const product = item.product;
    return [
      product.name,
      product.code || "-",
      item.purchasePriceUsd === null ? "-" : money(item.purchasePriceUsd, 2),
      item.weightLb === null ? "-" : money(item.weightLb, 2),
      item.chargedWeightLb === null ? "-" : money(item.chargedWeightLb, 2),
      item.courierUsd === null ? "-" : money(item.courierUsd, 2),
      money(item.costCrc),
      money(item.gamPriceCrc),
      money(item.puertoPriceCrc),
      item.inventory ? String((product as ProductRecord).quantityAvailable) : "-",
      item.inventory && (product as ProductRecord).minimumStockEnabled ? String((product as ProductRecord).minimumStock) : "-",
      dateText(parseUpdatedAt(product.updatedAt)),
    ];
  }

  function addSection(section: string, rows: InventoryRow[], incompleteSection: boolean) {
    let state = addPage(section, incompleteSection, true);
    if (!rows.length) {
      state.page.drawText("No hay productos en esta sección.", { x: margin, y: state.y - 28, size: 10, font: regular, color: colors.muted });
      return;
    }
    rows.forEach((item, rowIndex) => {
      const values = rowValues(item);
      const lineSets = values.map((value, index) => wrap(value, widths[index] - 6, 6.4, index < 2 ? Number.POSITIVE_INFINITY : 1));
      const rowHeight = Math.max(19, Math.max(...lineSets.map((lines) => lines.length)) * 7.2 + 7);
      if (state.y - rowHeight < 34) state = addPage(section, incompleteSection, false);
      const lowStock = item.inventory && (item.product as ProductRecord).minimumStockEnabled && (item.product as ProductRecord).quantityAvailable <= (item.product as ProductRecord).minimumStock;
      const fill = lowStock ? colors.redLight : incompleteSection ? colors.amberLight : rowIndex % 2 ? colors.greenLight : colors.white;
      let x = margin;
      values.forEach((_value, columnIndex) => {
        state.page.drawRectangle({ x, y: state.y - rowHeight, width: widths[columnIndex], height: rowHeight, color: fill, borderColor: colors.line, borderWidth: 0.35 });
        const lines = lineSets[columnIndex];
        lines.forEach((line, lineIndex) => {
          const size = 6.4;
          const lineWidth = regular.widthOfTextAtSize(line, size);
          const rightAligned = columnIndex >= 2 && columnIndex <= 10;
          state.page.drawText(line, {
            x: rightAligned ? x + widths[columnIndex] - lineWidth - 3 : x + 3,
            y: state.y - 10 - lineIndex * 7.2,
            size,
            font: regular,
            color: colors.ink,
          });
        });
        x += widths[columnIndex];
      });
      state.y -= rowHeight;
    });
  }

  addSection(`Productos completos (${complete.length})`, complete, false);
  addSection(`Productos incompletos (${incomplete.length})`, incomplete, true);
  addSection(`No inventario (${noInventory.length})`, noInventory, false);
  const pages = pdf.getPages();
  pages.forEach((page, index) => {
    const pageText = `Página ${index + 1} de ${pages.length}`;
    const width = regular.widthOfTextAtSize(pageText, 7);
    page.drawText(pageText, { x: pageSize[0] - margin - width, y: 14, size: 7, font: regular, color: colors.muted });
  });
  return pdf.save();
}

export async function createInventoryArtifacts(products: ProductRecord[], quotes: NonInventoryRecord[], settings: PricingSettings, format: "excel" | "pdf" | "both" = "both") {
  const generatedAt = new Date();
  const rows = products
    .map((product) => toInventoryRow(product, settings))
    .sort((a, b) => a.product.name.localeCompare(b.product.name, "es", { sensitivity: "base" }));
  const complete = rows.filter((row) => hasCompletePricing(row.product));
  const incomplete = rows.filter((row) => !hasCompletePricing(row.product));
  const noInventory = quotes
    .map((quote) => toNonInventoryRow(quote, settings))
    .sort((a, b) => b.product.updatedAt.localeCompare(a.product.updatedAt));
  const [xlsxBytes, pdfBytes] = await Promise.all([
    format === "pdf" ? Promise.resolve(null) : createExcel(complete, incomplete, noInventory, generatedAt, settings.extraWeightLb),
    format === "excel" ? Promise.resolve(null) : createPdf(complete, incomplete, noInventory, generatedAt, settings.extraWeightLb),
  ]);
  const stamp = dateStamp(generatedAt);
  const excelArray = xlsxBytes === null ? null : xlsxBytes instanceof ArrayBuffer ? new Uint8Array(xlsxBytes) : new Uint8Array(xlsxBytes as ArrayLike<number>);
  return {
    complete: complete.length,
    incomplete: incomplete.length,
    excelArray,
    noInventory: noInventory.length,
    pdfArray: pdfBytes === null ? null : new Uint8Array(pdfBytes),
    excelFilename: `inventario-nutriplus-${stamp}.xlsx`,
    pdfFilename: `inventario-nutriplus-${stamp}.pdf`,
  };
}

export async function exportInventoryFiles(products: ProductRecord[], quotes: NonInventoryRecord[], settings: PricingSettings, format: "excel" | "pdf" | "both") {
  const result = await createInventoryArtifacts(products, quotes, settings, format);
  if (result.excelArray) download(new Blob([result.excelArray], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), result.excelFilename);
  if (result.pdfArray) download(new Blob([result.pdfArray], { type: "application/pdf" }), result.pdfFilename);
  return { complete: result.complete, incomplete: result.incomplete, noInventory: result.noInventory };
}
