import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { ApiError, collectionsExportLink, getCollections, normalizeBuckets, type CollectionFilters } from "../lib/api";
import type { CollectionBucket, Collections } from "../lib/types";
import { formatMinor } from "../lib/format";
import { Card, EmptyState, ErrorState, Loading } from "../components/ui";

const inputCls = "rounded border px-2 py-1.5 text-sm";

function BucketTable({ title, buckets, currency }: { title: string; buckets: CollectionBucket[]; currency?: string }) {
  if (buckets.length === 0) return null;
  return (
    <Card>
      <h2 className="mb-2 font-semibold">{title}</h2>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-gray-500">
            <th className="py-1.5 pr-3">Key</th>
            <th className="py-1.5 pr-3">Collected (SUM succeeded)</th>
            <th className="py-1.5 pr-3">Payments</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((b) => (
            <tr key={b.key} className="border-b last:border-0">
              <td className="py-1.5 pr-3 font-mono text-xs">{b.key}</td>
              <td className="py-1.5 pr-3">{b.currency || currency ? formatMinor(b.totalMinor, (b.currency ?? currency) as string) : `${b.totalMinor} minor`}</td>
              <td className="py-1.5 pr-3">{b.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export default function CollectionsPage() {
  const [filters, setFilters] = useState<CollectionFilters>({});
  const [draft, setDraft] = useState({ country: "", network: "", provider: "", from: "", to: "" });
  const [data, setData] = useState<Collections | null>(null);
  const [state, setState] = useState<"loading" | "error" | "done">("loading");
  const [error, setError] = useState("");

  const load = useCallback(async (f: CollectionFilters) => {
    setState("loading");
    try {
      const res = await getCollections(f);
      setData({
        byCountry: normalizeBuckets(res.byCountry),
        byNetwork: normalizeBuckets(res.byNetwork),
        byProvider: normalizeBuckets(res.byProvider),
        period: res.period,
      });
      setState("done");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (k: keyof typeof draft) => (e: ChangeEvent<HTMLInputElement>) =>
    setDraft({ ...draft, [k]: e.target.value });

  function apply() {
    const f: CollectionFilters = {
      country: draft.country || undefined,
      network: draft.network || undefined,
      provider: draft.provider || undefined,
      from: draft.from ? new Date(draft.from).toISOString() : undefined,
      to: draft.to ? new Date(draft.to).toISOString() : undefined,
    };
    setFilters(f);
    void load(f);
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Collections</h1>
      <p className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        Read-only aggregates: <code>SUM(amount_minor) WHERE status = succeeded</code> grouped by
        country, network, provider and period. These are collected totals —{" "}
        <strong>never an available balance</strong>.
      </p>

      <Card>
        <div className="flex flex-wrap items-end gap-2">
          <input value={draft.country} onChange={set("country")} placeholder="Country (CD)" className={inputCls} aria-label="Country filter" />
          <input value={draft.network} onChange={set("network")} placeholder="Network" className={inputCls} aria-label="Network filter" />
          <input value={draft.provider} onChange={set("provider")} placeholder="Provider" className={inputCls} aria-label="Provider filter" />
          <label className="text-sm">From <input type="datetime-local" value={draft.from} onChange={set("from")} className={inputCls} /></label>
          <label className="text-sm">To <input type="datetime-local" value={draft.to} onChange={set("to")} className={inputCls} /></label>
          <button onClick={apply} className="rounded bg-gray-900 px-4 py-1.5 text-sm text-white">Apply</button>
          <a
            href={collectionsExportLink(filters)}
            className="rounded border px-4 py-1.5 text-sm hover:bg-gray-100"
            download
          >
            Export CSV
          </a>
        </div>
      </Card>

      {state === "loading" && <Loading label="Loading collections…" />}
      {state === "error" && <ErrorState message={error} onRetry={() => load(filters)} />}
      {state === "done" && data && (
        <>
          {(data.byCountry.length + data.byNetwork.length + data.byProvider.length) === 0 && (
            <EmptyState title="No collected amounts in this period" hint="Adjust filters or period. No demo data is shown." />
          )}
          <BucketTable title="By country" buckets={data.byCountry} />
          <BucketTable title="By network" buckets={data.byNetwork} />
          <BucketTable title="By provider" buckets={data.byProvider} />
        </>
      )}
    </div>
  );
}
