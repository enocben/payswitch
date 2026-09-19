// @payswitch/api — bootstrap HTTP (Bun.serve, spec §12/§14).
// Env : DATABASE_URL, PORT, MOCK_SCENARIO, WEBHOOK_OUTBOUND_SECRET,
// PAYMENT_EXPIRATION_HOURS, RATE_LIMIT_PER_MIN, WEBHOOK_RETRY_SCHEDULE,
// WEBHOOK_MAX_RETRIES, SESSION_TTL_HOURS. Workers polling+outbound démarrés
// (non-bloquants, erreurs isolées).

import { SQL } from "bun";
import { MockProvider, type PaymentProvider, type ProviderCapabilities } from "@payswitch/core";
import { db, closeDb } from "../infrastructure/database/client.js";
import { createApp } from "./server.js";

const PORT = Number(process.env.PORT ?? "3000");
const SCENARIO = (process.env.MOCK_SCENARIO ?? "success") as
  | "success" | "confirmed_failed" | "temporary_failure" | "timeout_unknown" | "pending";

const CAPS: ProviderCapabilities = {
  supported_countries: ["CD", "CG", "CI"],
  supported_networks: { CD: ["AIRTEL", "ORANGE"], CG: ["AIRTEL"], CI: ["WAVE"] },
  supported_currencies: ["CDF", "XAF", "XOF"],
  min_amount_minor: 100n,
  max_amount_minor: 100_000_000n,
  operations: ["collect"],
  supports_idempotency: true,
};

function buildProviders(): Map<string, PaymentProvider> {
  const m = new Map<string, PaymentProvider>();
  m.set("mockprimary", new MockProvider({ code: "mockprimary", capabilities: CAPS, scenario: SCENARIO }));
  m.set("mocksecondary", new MockProvider({ code: "mocksecondary", capabilities: CAPS, scenario: SCENARIO }));
  return m;
}

const master = process.env.WEBHOOK_OUTBOUND_SECRET?.trim();
if (!master) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "warn", msg: "WEBHOOK_OUTBOUND_SECRET unset — ephemeral master (signatures invalides après restart)" }));
}

const sql: SQL = db();
const app = createApp({
  sql,
  providers: buildProviders(),
  masterSecret: master || `ephemeral-${Date.now()}`,
  sessionTtlMs: Number(process.env.SESSION_TTL_HOURS ?? "12") * 3_600_000,
  paymentsPerMin: Number(process.env.RATE_LIMIT_PER_MIN ?? "60"),
  retryScheduleRaw: process.env.WEBHOOK_RETRY_SCHEDULE,
  maxRetries: Number(process.env.WEBHOOK_MAX_RETRIES ?? "6"),
});

const server = Bun.serve({ port: PORT, fetch: app.fetch });
console.log(JSON.stringify({ ts: new Date().toISOString(), msg: `api listening on :${server.port}`, scenario: SCENARIO }));

const shutdown = async () => {
  app.close();
  server.stop();
  await closeDb();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
