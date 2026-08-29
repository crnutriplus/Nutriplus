import { ensureDatabase, getD1 } from "@/db";
import { financeErrorResponse, financeRange, loadFinanceSnapshot } from "@/lib/finance";
import { createFinanceExcel, createFinancePdf } from "@/lib/finance-export";

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const url = new URL(request.url);
    const snapshot = await loadFinanceSnapshot(getD1(), financeRange(url));
    const format = url.searchParams.get("format") === "pdf" ? "pdf" : "excel";
    const bytes = format === "pdf" ? await createFinancePdf(snapshot) : await createFinanceExcel(snapshot);
    const extension = format === "pdf" ? "pdf" : "xlsx";
    const type = format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    return new Response(bytes as BodyInit, { headers: {
      "Content-Type": type,
      "Content-Disposition": `attachment; filename="finanzas-${snapshot.range.from}-${snapshot.range.to}.${extension}"`,
      "Cache-Control": "no-store",
    } });
  } catch (error) { return financeErrorResponse(error); }
}
