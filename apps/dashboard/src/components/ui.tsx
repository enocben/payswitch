import type { ReactNode } from "react";

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded border border-dashed bg-white p-8 text-center">
      <p className="font-medium">{title}</p>
      {hint && <p className="mt-1 text-sm text-gray-500">{hint}</p>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const unreachable = /unreachable|Failed to fetch|NetworkError/i.test(message);
  return (
    <div className="rounded border border-red-200 bg-red-50 p-6 text-center" role="alert">
      <p className="font-medium text-red-800">
        {unreachable ? "API unreachable" : "Something went wrong"}
      </p>
      <p className="mt-1 text-sm text-red-700">{message}</p>
      {unreachable && (
        <p className="mt-1 text-xs text-red-600">
          The REST API is built in parallel (sibling wave). Set VITE_API_URL and retry once it is up — no demo data is shown.
        </p>
      )}
      {onRetry && (
        <button onClick={onRetry} className="mt-3 rounded bg-red-700 px-4 py-1.5 text-sm text-white hover:bg-red-800">
          Retry
        </button>
      )}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <p className="py-8 text-center text-sm text-gray-500">{label}</p>;
}

export function Card({ children }: { children: ReactNode }) {
  return <section className="rounded border bg-white p-4 shadow-sm">{children}</section>;
}

const STATUS_COLORS: Record<string, string> = {
  succeeded: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  pending: "bg-yellow-100 text-yellow-800",
  processing: "bg-blue-100 text-blue-800",
  created: "bg-gray-100 text-gray-700",
  unknown: "bg-orange-100 text-orange-800",
  expired: "bg-purple-100 text-purple-800",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-semibold ${STATUS_COLORS[status] ?? "bg-gray-100 text-gray-700"}`}>
      {status}
    </span>
  );
}
