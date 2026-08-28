import { pdfBoldFontUrl, pdfRegularFontUrl } from "./pdf-fonts";
import { OrderError, costaRicaDate } from "./orders";
import { loadOrder } from "./orders-service";

type PrintLine = {
  productId: number | null;
  productName: string;
  quantity: number;
  pendingDeliveryQuantity: number;
};

export type OrdersPrintModel = {
  date: string;
  orderTotal: number;
  amountToCollectTotal: number;
  shippingTotal: number;
  rows: Array<{
    position: number;
    phone: string;
    address: string;
    products: string[];
    subtotal: number;
    discountTotal: number;
    deliveryFee: number;
    orderTotal: number;
    paidTotal: number;
    amountToCollect: number;
    expectedPaymentMethod: string | null;
    cash: boolean;
    sinpe: boolean;
    card: boolean;
  }>;
  productsToLoad: Array<{
    productId: number | null;
    productName: string;
    quantity: number;
    manual: boolean;
  }>;
};

function crc(value: number) {
  return `₡${new Intl.NumberFormat("es-CR", { maximumFractionDigits: 0 }).format(Math.round(value))}`;
}

function safeText(value: string) {
  return value
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\u00a0/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function buildOrdersPrintModel(db: D1Database, rawDate: unknown): Promise<OrdersPrintModel> {
  const date = costaRicaDate(rawDate, "La fecha de impresión");
  if (!date) throw new OrderError("Seleccioná la fecha que querés imprimir. No se generó ningún documento.", 400, "ORDER_PRINT_DATE_REQUIRED", "Fecha requerida");
  const result = await db.prepare(`SELECT o.id FROM orders o
    LEFT JOIN route_orders ro ON ro.order_id=o.id AND ro.removed_at IS NULL
    WHERE o.scheduled_delivery_date=? AND o.status<>'CANCELLED'
    ORDER BY CASE WHEN ro.position IS NULL THEN 1 ELSE 0 END,ro.position,o.created_at,o.id LIMIT 1001`).bind(date).all<{ id: string }>();
  if (result.results.length > 1000) {
    throw new OrderError("La fecha contiene más de 1.000 pedidos. Dividí la operación en rutas antes de imprimir; no se generó un documento incompleto.", 409, "ORDER_PRINT_LIMIT", "Demasiados pedidos");
  }
  const orders = (await Promise.all(result.results.map((row) => loadOrder(db, row.id)))).filter((order) => order !== null);
  const rows = orders.map((order, index) => {
    const products = (order.lines || []).map((line: PrintLine) => `${line.productName} × ${line.quantity}`);
    return {
      position: index + 1,
      phone: order.phoneRaw || order.phoneNormalized || "-",
      address: order.deliveryAddress || order.deliveryInstructions || "Sin dirección",
      products,
      subtotal: order.subtotal,
      discountTotal: order.discountTotal,
      deliveryFee: order.deliveryFee,
      orderTotal: order.total,
      paidTotal: order.paidTotal,
      amountToCollect: order.balance,
      expectedPaymentMethod: order.expectedPaymentMethod,
      cash: order.expectedPaymentMethod === "CASH",
      sinpe: order.expectedPaymentMethod === "SINPE",
      card: order.expectedPaymentMethod === "CARD",
    };
  });
  const loadMap = new Map<string, { productId: number | null; productName: string; quantity: number; manual: boolean }>();
  orders.filter((order) => ["CONFIRMED", "PREPARED"].includes(order.status)).forEach((order) => {
    (order.lines || []).forEach((line: PrintLine) => {
      if (line.pendingDeliveryQuantity < 1) return;
      const key = line.productId ? `product:${line.productId}` : `manual:${line.productName.trim().toLowerCase()}`;
      const current = loadMap.get(key) || { productId: line.productId, productName: line.productName, quantity: 0, manual: line.productId === null };
      current.quantity += line.pendingDeliveryQuantity;
      loadMap.set(key, current);
    });
  });
  return {
    date,
    orderTotal: orders.reduce((sum, order) => sum + order.total, 0),
    amountToCollectTotal: orders.reduce((sum, order) => sum + order.balance, 0),
    shippingTotal: orders.reduce((sum, order) => sum + order.deliveryFee, 0),
    rows,
    productsToLoad: [...loadMap.values()].sort((left, right) => left.productName.localeCompare(right.productName, "es", { sensitivity: "base" })),
  };
}

export async function createOrdersPrintPdf(model: OrdersPrintModel) {
  const [{ PDFDocument, rgb }, fontkitModule] = await Promise.all([import("pdf-lib"), import("@pdf-lib/fontkit")]);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkitModule.default);
  pdf.setTitle(`Hoja de pedidos ${model.date}`);
  pdf.setAuthor("NutriPlus Supplements");
  pdf.setSubject("Ruta operativa de Pedidos");
  const [regularResponse, boldResponse] = await Promise.all([fetch(pdfRegularFontUrl), fetch(pdfBoldFontUrl)]);
  if (!regularResponse.ok || !boldResponse.ok) throw new Error("No se pudo preparar la tipografía de la hoja de pedidos.");
  const [regularBytes, boldBytes] = await Promise.all([regularResponse.arrayBuffer(), boldResponse.arrayBuffer()]);
  const regular = await pdf.embedFont(regularBytes, { subset: true });
  const bold = await pdf.embedFont(boldBytes, { subset: true });
  const pageSize: [number, number] = [841.89, 595.28];
  const margin = 24;
  const widths = [26, 88, 188, 263, 91, 30, 30, 30];
  const headers = ["#", "Teléfono", "Dirección", "Productos", "Totales", "E", "S", "T"];
  const colors = {
    green: rgb(40 / 255, 94 / 255, 63 / 255),
    greenDark: rgb(25 / 255, 59 / 255, 43 / 255),
    greenLight: rgb(239 / 255, 246 / 255, 236 / 255),
    ink: rgb(41 / 255, 50 / 255, 41 / 255),
    muted: rgb(105 / 255, 116 / 255, 106 / 255),
    line: rgb(217 / 255, 226 / 255, 215 / 255),
    white: rgb(1, 1, 1),
    brown: rgb(132 / 255, 84 / 255, 48 / 255),
  };

  function wrap(value: string, width: number, size: number) {
    const words = safeText(value).split(" ").filter(Boolean);
    const lines: string[] = [];
    let current = "";
    words.forEach((word) => {
      const attempt = current ? `${current} ${word}` : word;
      if (!current || regular.widthOfTextAtSize(attempt, size) <= width) current = attempt;
      else { lines.push(current); current = word; }
    });
    if (current) lines.push(current);
    return lines.length ? lines : ["-"];
  }

  function addPage() {
    const page = pdf.addPage(pageSize);
    const pageHeight = pageSize[1];
    page.drawRectangle({ x: 0, y: pageHeight - 66, width: pageSize[0], height: 66, color: colors.greenDark });
    page.drawText("NUTRIPLUS · HOJA DE PEDIDOS", { x: margin, y: pageHeight - 25, size: 13, font: bold, color: colors.white });
    page.drawText(`FECHA  ${model.date}`, { x: margin, y: pageHeight - 47, size: 9, font: bold, color: colors.white });
    page.drawText(`TOTAL  ${crc(model.orderTotal)}`, { x: 285, y: pageHeight - 47, size: 9, font: bold, color: colors.white });
    page.drawText(`ENVÍO  ${crc(model.shippingTotal)}`, { x: 535, y: pageHeight - 47, size: 9, font: bold, color: colors.white });
    const y = pageHeight - 76;
    let x = margin;
    headers.forEach((header, index) => {
      page.drawRectangle({ x, y: y - 24, width: widths[index], height: 24, color: colors.green });
      const textWidth = bold.widthOfTextAtSize(header, 7.2);
      page.drawText(header, { x: x + Math.max(3, (widths[index] - textWidth) / 2), y: y - 15, size: 7.2, font: bold, color: colors.white });
      x += widths[index];
    });
    return { page, y: y - 24 };
  }

  let state = addPage();
  if (!model.rows.length) {
    state.page.drawText("No hay pedidos activos para esta fecha.", { x: margin, y: state.y - 28, size: 10, font: regular, color: colors.muted });
    state.y -= 48;
  }
  model.rows.forEach((row, rowIndex) => {
    const values = [
      String(row.position),
      row.phone,
      row.address,
      row.products.join("\n"),
      [
        `Subtotal ${crc(row.subtotal)}`,
        ...(row.discountTotal > 0 ? [`Descuento -${crc(row.discountTotal)}`] : []),
        `Envío +${crc(row.deliveryFee)}`,
        `Total ${crc(row.orderTotal)}`,
        ...(row.paidTotal > 0 ? [`Abonado -${crc(row.paidTotal)}`] : []),
        `Saldo ${crc(row.amountToCollect)}`,
      ].join("\n"),
      row.cash ? "X" : "",
      row.sinpe ? "X" : "",
      row.card ? "X" : "",
    ];
    const lineSets = values.map((value, index) => index === 3 || index === 4
      ? value.split("\n").flatMap((line) => wrap(line, widths[index] - 7, 7.1))
      : wrap(value, widths[index] - 7, 7.1));
    const rowHeight = Math.max(23, Math.max(...lineSets.map((lines) => lines.length)) * 8.2 + 8);
    if (state.y - rowHeight < 38) state = addPage();
    let x = margin;
    values.forEach((_value, columnIndex) => {
      state.page.drawRectangle({
        x,
        y: state.y - rowHeight,
        width: widths[columnIndex],
        height: rowHeight,
        color: rowIndex % 2 ? colors.greenLight : colors.white,
        borderColor: colors.line,
        borderWidth: .4,
      });
      lineSets[columnIndex].forEach((line, lineIndex) => {
        const size = 7.1;
        const width = regular.widthOfTextAtSize(line, size);
        const centered = columnIndex === 0 || columnIndex >= 5;
        const right = columnIndex === 4;
        state.page.drawText(line, {
          x: centered ? x + (widths[columnIndex] - width) / 2 : right ? x + widths[columnIndex] - width - 4 : x + 4,
          y: state.y - 12 - lineIndex * 8.2,
          size,
          font: columnIndex === 4 || columnIndex >= 5 ? bold : regular,
          color: colors.ink,
        });
      });
      x += widths[columnIndex];
    });
    state.y -= rowHeight;
  });

  const sectionHeaderHeight = 29;
  if (state.y - sectionHeaderHeight - 42 < 38) state = addPage();
  state.y -= 13;
  state.page.drawRectangle({ x: margin, y: state.y - sectionHeaderHeight, width: 746, height: sectionHeaderHeight, color: colors.brown });
  state.page.drawText("PRODUCTOS PARA CARGAR", { x: margin + 10, y: state.y - 18, size: 10, font: bold, color: colors.white });
  state.y -= sectionHeaderHeight;
  if (!model.productsToLoad.length) {
    state.page.drawText("No hay productos confirmados o preparados para consolidar.", { x: margin + 4, y: state.y - 22, size: 8, font: regular, color: colors.muted });
    state.y -= 35;
  }
  model.productsToLoad.forEach((product, index) => {
    const label = `${product.productName} × ${product.quantity}${product.manual ? " · MANUAL / NO INVENTARIO" : ""}`;
    const lines = wrap(label, 730, 8.2);
    const height = Math.max(22, lines.length * 9 + 7);
    if (state.y - height < 38) {
      state = addPage();
      state.page.drawText("PRODUCTOS PARA CARGAR · continuación", { x: margin, y: state.y - 18, size: 10, font: bold, color: colors.brown });
      state.y -= 30;
    }
    state.page.drawRectangle({ x: margin, y: state.y - height, width: 746, height, color: index % 2 ? colors.greenLight : colors.white, borderColor: colors.line, borderWidth: .4 });
    lines.forEach((line, lineIndex) => state.page.drawText(line, { x: margin + 7, y: state.y - 14 - lineIndex * 9, size: 8.2, font: regular, color: colors.ink }));
    state.y -= height;
  });

  const pages = pdf.getPages();
  pages.forEach((page, index) => {
    const label = `Página ${index + 1} de ${pages.length}`;
    const width = regular.widthOfTextAtSize(label, 7);
    page.drawText(label, { x: pageSize[0] - margin - width, y: 15, size: 7, font: regular, color: colors.muted });
  });
  return pdf.save();
}
