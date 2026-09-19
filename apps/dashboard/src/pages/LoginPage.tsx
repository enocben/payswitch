import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export default function LoginPage() {
  const { login, loading, error } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: string } };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const ok = await login(email.trim(), password);
    if (ok) navigate(location.state?.from ?? "/payments", { replace: true });
  }

  return (
    <div className="mx-auto mt-16 max-w-sm rounded border bg-white p-6 shadow-sm">
      <h1 className="text-xl font-bold">Admin login</h1>
      <p className="mt-1 text-sm text-gray-500">
        Session cookies (HttpOnly). Login is rate-limited server-side.
      </p>
      <form onSubmit={onSubmit} className="mt-4 space-y-3">
        <label className="block text-sm">
          Email
          <input
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
          />
        </label>
        <label className="block text-sm">
          Password
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
          />
        </label>
        {error && (
          <p className="rounded bg-red-50 p-2 text-sm text-red-700" role="alert">{error}</p>
        )}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded bg-gray-900 px-4 py-2 text-white disabled:opacity-50"
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
