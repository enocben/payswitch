import { useEffect, useState } from "react";
import { ApiError, getRouting, putRouting, type RoutingUpdate } from "../lib/api";
import type { RoutingEntry } from "../lib/types";
import { Card, EmptyState, ErrorState, Loading } from "../components/ui";

function asList(raw: RoutingEntry[] | { data: RoutingEntry[] }): RoutingEntry[] {
  return Array.isArray(raw) ? raw : raw.data;
}

export default function RoutingPage() {
  const [entries, setEntries] = useState<RoutingEntry[]>([]);
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [auditNote, setAuditNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<"loading" | "error" | "done">("loading");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    getRouting()
      .then((r) => {
        const list = asList(r);
        setEntries(list);
        setDraft(Object.fromEntries(list.map((e) => [`${e.country}/${e.network}`, [...e.providers]])));
        setState("done");
      })
      .catch((e) => {
        setError(e instanceof ApiError ? e.message : String(e));
        setState("error");
      });
  }, []);

  function key(e: RoutingEntry) {
    return `${e.country}/${e.network}`;
  }

  function move(k: string, idx: number, dir: -1 | 1) {
    setDraft((d) => {
      const arr = [...(d[k] ?? [])];
      const j = idx + dir;
      if (j < 0 || j >= arr.length) return d;
      [arr[idx], arr[j]] = [arr[j], arr[idx]];
      return { ...d, [k]: arr };
    });
    setNotice("");
  }

  function dirty(k: string): boolean {
    const orig = entries.find((e) => key(e) === k)?.providers ?? [];
    return JSON.stringify(orig) !== JSON.stringify(draft[k] ?? []);
  }

  const anyDirty = Object.keys(draft).some(dirty);

  async function save() {
    setConfirming(false);
    setNotice("");
    const payload: RoutingUpdate[] = entries
      .filter((e) => dirty(key(e)))
      .map((e) => ({
        country: e.country,
        network: e.network,
        providers: draft[key(e)],
        auditNote: auditNote || undefined,
      }));
    if (payload.length === 0) return;
    try {
      const updated = await putRouting(payload);
      const list = asList(updated as unknown as RoutingEntry[] | { data: RoutingEntry[] });
      if (list.length > 0) {
        setEntries(list);
        setDraft(Object.fromEntries(list.map((e) => [`${e.country}/${e.network}`, [...e.providers]])));
      }
      setAuditNote("");
      setNotice(`Saved ${payload.length} routing change(s) — audit-logged server-side.`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setState("error");
    }
  }

  if (state === "loading") return <Loading label="Loading routing…" />;
  if (state === "error") return <ErrorState message={error} onRetry={() => window.location.reload()} />;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Routing priorities</h1>
      <p className="text-sm text-gray-500">
        Reorder providers per country-network only. Provider activation stays config-driven
        (<code>config/providers.ts</code> + <code>.env</code>) — there is intentionally no on/off toggle here.
      </p>

      {entries.length === 0 && (
        <EmptyState title="No routing rules" hint="Seed config/routing.ts once the API is live. No demo data is shown." />
      )}

      {entries.map((e) => {
        const k = key(e);
        const providers = draft[k] ?? [];
        return (
          <Card key={k}>
            <div className="mb-2 flex items-center gap-2">
              <h2 className="font-semibold">{e.country} / {e.network}</h2>
              {dirty(k) && <span className="rounded bg-yellow-100 px-2 py-0.5 text-xs text-yellow-800">modified</span>}
            </div>
            <ol className="space-y-1">
              {providers.map((p, i) => (
                <li key={p} className="flex items-center gap-2 rounded border px-3 py-1.5 text-sm">
                  <span className="w-6 font-mono text-gray-500">{i + 1}</span>
                  <span className="font-medium">{p}</span>
                  {e.supportsIdempotency && p in e.supportsIdempotency && (
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${e.supportsIdempotency[p] ? "bg-green-100 text-green-800" : "bg-orange-100 text-orange-800"}`}
                      title="supportsIdempotency — retry-unsafe providers need verify() first"
                    >
                      idempotency: {e.supportsIdempotency[p] ? "yes" : "no"}
                    </span>
                  )}
                  <span className="ml-auto flex gap-1">
                    <button onClick={() => move(k, i, -1)} disabled={i === 0} className="rounded border px-2 disabled:opacity-40" aria-label={`Move ${p} up`}>↑</button>
                    <button onClick={() => move(k, i, 1)} disabled={i === providers.length - 1} className="rounded border px-2 disabled:opacity-40" aria-label={`Move ${p} down`}>↓</button>
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        );
      })}

      {anyDirty && (
        <Card>
          {!confirming ? (
            <button onClick={() => setConfirming(true)} className="rounded bg-gray-900 px-4 py-2 text-sm text-white">
              Review & confirm changes
            </button>
          ) : (
            <div className="space-y-3">
              <p className="text-sm font-medium">Confirm priority changes (audit-logged with actor, IP, request_id server-side):</p>
              <ul className="list-disc pl-5 text-sm">
                {entries.filter((e) => dirty(key(e))).map((e) => (
                  <li key={key(e)}>
                    {key(e)}: [{e.providers.join(", ")}] → [{draft[key(e)].join(", ")}]
                  </li>
                ))}
              </ul>
              <label className="block text-sm">
                Audit note (recorded with the change)
                <input
                  value={auditNote}
                  onChange={(ev) => setAuditNote(ev.target.value)}
                  placeholder="e.g. pawapay outage, fallback first"
                  className="mt-1 w-full rounded border px-3 py-2"
                />
              </label>
              <div className="flex gap-2">
                <button onClick={save} className="rounded bg-gray-900 px-4 py-2 text-sm text-white">Confirm & save</button>
                <button onClick={() => setConfirming(false)} className="rounded border px-4 py-2 text-sm">Cancel</button>
              </div>
            </div>
          )}
          {notice && <p className="mt-2 text-sm text-green-700">{notice}</p>}
        </Card>
      )}
    </div>
  );
}
