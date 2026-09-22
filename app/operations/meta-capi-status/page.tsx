import { ensureDatabase, getD1 } from "@/db";
import {
  loadMetaCapiStatus,
  parseMetaCapiOrderNumber,
  type MetaCapiStatusRow,
} from "@/lib/meta-capi-status";

export default async function MetaCapiStatusPage({
  searchParams,
}: {
  searchParams: Promise<{ orderNumber?: string }>;
}) {
  const params = await searchParams;
  const raw = params.orderNumber ?? "";

  let orderNumber = "";
  let jobs: MetaCapiStatusRow[] = [];
  let error: string | null = null;

  if (raw) {
    try {
      orderNumber = parseMetaCapiOrderNumber(raw);
      await ensureDatabase();
      jobs = await loadMetaCapiStatus(getD1(), orderNumber);
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : "No se pudo consultar Meta CAPI.";
    }
  }

  const result = error
    ? { error }
    : { orderNumber, count: jobs.length, jobs };

  return (
    <main style={{ padding: 24, fontFamily: "sans-serif" }}>
      <h1>Meta CAPI Status</h1>

      <form method="get">
        <input
          name="orderNumber"
          defaultValue={raw}
          placeholder="NP-000020"
        />
        <button type="submit">Consultar</button>
      </form>

      <pre style={{ marginTop: 24, whiteSpace: "pre-wrap" }}>
        {JSON.stringify(result, null, 2)}
      </pre>
    </main>
  );
}
