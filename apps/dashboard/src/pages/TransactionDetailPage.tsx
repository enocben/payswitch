import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, getPayment } from "../lib/api";
import type { Payment } from "../lib/types";
import { formatDateTime, formatMinor, maskPhone } from "../lib/format";
import { Card, EmptyState, ErrorState, Loading, StatusBadge } from "../components/ui";

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex gap-3 border-b py-1.5 text-sm last:border-0">
      <dt className="w-44 shrink-0 text-gray-500">{k}</dt>
      <dd className={mono ? "font-mono text-xs break-all" : "break-all"}>{v}</dd>
    </div>
  );
}

export default function TransactionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [payment, setPayment] = useState<Payment | null>(null);
  const [state, setState] = useState<"loading" | "error" | "done">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    getPayment(id)
      .then((p) => {
        setPayment(p);
        setState("done");
      })
      .catch((e) => {
        setError(e instanceof ApiError ? e.message : String(e));
        setState("error");
      });
  }, [id]);

  if (state === "loading") return <Loading label="Loading payment…" />;
  if (state === "error") return <ErrorState message={error} onRetry={() => window.location.reload()} />;
  if (!payment) return <EmptyState title="Payment not found" />;

  const gross = payment.amountGrossMinor ?? payment.amountMinor;
  const fee = payment.amountFeeMinor ?? 0;
  const net = payment.amountNetMinor ?? payment.amountMinor - fee;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link to="/payments" className="text-sm text-blue-700 underline">← Transactions</Link>
        <h1 className="font-mono text-lg font-bold">{payment.id}</h1>
        <StatusBadge status={payment.status} />
      </div>

      <Card>
        <h2 className="mb-2 font-semibold">Payment</h2>
        <dl>
          <Row k="Phone" v={maskPhone(payment.phoneMasked)} mono />
          <Row k="Country / Network" v={`${payment.country} / ${payment.network}`} />
          <Row k="Currency" v={payment.currency} />
          <Row k="Amount (minor, source of truth)" v={String(payment.amountMinor)} mono />
          <Row k="Gross" v={formatMinor(gross, payment.currency)} />
          <Row k="Fee" v={formatMinor(fee, payment.currency)} />
          <Row k="Net" v={formatMinor(net, payment.currency)} />
          <Row k="Provider" v={payment.provider ?? "—"} />
          <Row k="providerReference" v={payment.providerReference ?? "—"} mono />
          <Row k="external_reference" v={payment.externalReference ?? "—"} mono />
          <Row k="idempotency_key" v={payment.idempotencyKey ?? "—"} mono />
          <Row k="correlation_id" v={payment.correlationId} mono />
          <Row k="Created" v={formatDateTime(payment.createdAt)} />
          <Row k="Updated" v={formatDateTime(payment.updatedAt)} />
        </dl>
      </Card>

      {payment.metadata && (
        <Card>
          <h2 className="mb-2 font-semibold">Metadata</h2>
          <pre className="overflow-x-auto rounded bg-gray-50 p-3 font-mono text-xs">
            {JSON.stringify(payment.metadata, null, 2)}
          </pre>
        </Card>
      )}

      <Card>
        <h2 className="mb-2 font-semibold">Attempts timeline ({payment.attempts?.length ?? 0})</h2>
        {!payment.attempts || payment.attempts.length === 0 ? (
          <p className="text-sm text-gray-500">No attempts recorded yet.</p>
        ) : (
          <ol className="space-y-3">
            {[...payment.attempts]
              .sort((a, b) => a.attemptNumber - b.attemptNumber)
              .map((a) => (
                <li key={a.id} className="rounded border p-3 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">#{a.attemptNumber} {a.provider}</span>
                    <StatusBadge status={a.status} />
                    <span className="ml-auto text-xs text-gray-500">{formatDateTime(a.createdAt)}</span>
                  </div>
                  <dl className="mt-1">
                    <Row k="providerReference" v={a.providerReference ?? "—"} mono />
                    <Row k="providerIdempotencyKey" v={a.providerIdempotencyKey} mono />
                  </dl>
                </li>
              ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
