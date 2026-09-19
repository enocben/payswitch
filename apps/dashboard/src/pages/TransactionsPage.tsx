import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { Link } from "react-router-dom";
import { ApiError, listPayments } from "../lib/api";
import type { Payment, PaymentFilters } from "../lib/types";
import { formatDateTime, formatMinor, maskPhone } from "../lib/format";
import { Card, EmptyState, ErrorState, Loading, StatusBadge } from "../components/ui";

const STATUSES = ["", "created", "processing", "pending", "succeeded", "failed", "unknown", "expired"];

const inputCls = "rounded border px-2 py-1.5 text-sm";

export default function TransactionsPage() {
  const [filters, setFilters] = useState<PaymentFilters>({ page: 1, perPage: 20 });
  const [draft, setDraft] = useState({ status: "", country: "", network: "", provider: "", phone: "", externalReference: "" });
  const [payments, setPayments] = useState<Payment[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<"idle" | "loading" | "error" | "done">("idle");
  const [error, setError] = useState("");

  const load = useCallback(async (f: PaymentFilters) => {
    setState("loading");
    try {
      const res = await listPayments(f);
      setPayments(res.data);
      setTotal(res.meta.total);
      setState("done");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load(filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function apply() {
    const f: PaymentFilters = {
      ...filters,
      page: 1,
      status: draft.status || undefined,
      country: draft.country || undefined,
      network: draft.network || undefined,
      provider: draft.provider || undefined,
      phone: draft.phone || undefined,
      externalReference: draft.externalReference || undefined,
    };
    setFilters(f);
    void load(f);
  }

  function page(delta: number) {
    const f = { ...filters, page: Math.max(1, (filters.page ?? 1) + delta) };
    setFilters(f);
    void load(f);
  }

  const set = (k: keyof typeof draft) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setDraft({ ...draft, [k]: e.target.value });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Transactions</h1>

      <Card>
        <div className="flex flex-wrap gap-2">
          <select value={draft.status} onChange={set("status")} className={inputCls} aria-label="Status filter">
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s || "all statuses"}</option>
            ))}
          </select>
          <input value={draft.country} onChange={set("country")} placeholder="Country (CD)" className={inputCls} aria-label="Country filter" />
          <input value={draft.network} onChange={set("network")} placeholder="Network (AIRTEL)" className={inputCls} aria-label="Network filter" />
          <input value={draft.provider} onChange={set("provider")} placeholder="Provider" className={inputCls} aria-label="Provider filter" />
          <input value={draft.phone} onChange={set("phone")} placeholder="Phone" className={inputCls} aria-label="Phone filter" />
          <input value={draft.externalReference} onChange={set("externalReference")} placeholder="External ref" className={inputCls} aria-label="External reference filter" />
          <button onClick={apply} className="rounded bg-gray-900 px-4 py-1.5 text-sm text-white">Filter</button>
        </div>
      </Card>

      {state === "loading" && <Loading label="Loading transactions…" />}
      {state === "error" && <ErrorState message={error} onRetry={() => load(filters)} />}
      {state === "done" && payments.length === 0 && (
        <EmptyState title="No transactions found" hint="Adjust filters, or seed/collect a payment once the API is live. No demo data is shown." />
      )}
      {state === "done" && payments.length > 0 && (
        <Card>
          <p className="mb-2 text-sm text-gray-500">{total} result(s)</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-gray-500">
                  <th className="py-2 pr-3">ID</th>
                  <th className="py-2 pr-3">Phone</th>
                  <th className="py-2 pr-3">Country/Network</th>
                  <th className="py-2 pr-3">Provider</th>
                  <th className="py-2 pr-3">Amount</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Attempts</th>
                  <th className="py-2 pr-3">Correlation</th>
                  <th className="py-2 pr-3">Created</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id} className="border-b last:border-0 hover:bg-gray-50">
                    <td className="py-2 pr-3 font-mono text-xs">
                      <Link to={`/payments/${p.id}`} className="text-blue-700 underline">{p.id.slice(0, 8)}…</Link>
                    </td>
                    <td className="py-2 pr-3 font-mono">{maskPhone(p.phoneMasked)}</td>
                    <td className="py-2 pr-3">{p.country} / {p.network}</td>
                    <td className="py-2 pr-3">{p.provider ?? "—"}</td>
                    <td className="py-2 pr-3">{formatMinor(p.amountMinor, p.currency)}</td>
                    <td className="py-2 pr-3"><StatusBadge status={p.status} /></td>
                    <td className="py-2 pr-3">{p.attempts?.length ?? "—"}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{p.correlationId.slice(0, 8)}…</td>
                    <td className="py-2 pr-3 text-xs">{formatDateTime(p.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex gap-2 text-sm">
            <button onClick={() => page(-1)} disabled={(filters.page ?? 1) <= 1} className="rounded border px-3 py-1 disabled:opacity-40">← Prev</button>
            <span className="px-2 py-1 text-gray-500">page {filters.page ?? 1}</span>
            <button onClick={() => page(1)} className="rounded border px-3 py-1">Next →</button>
          </div>
        </Card>
      )}
    </div>
  );
}
