// @payswitch/api — auth HTTP (spec §7.1, §10.1, §11).
// Clés mg_live_/mg_test_ : lookup par préfixe + Bun.password Argon2 + revoked_at.
// Sessions dashboard : cookie HttpOnly SameSite, Argon2. Rate limits en mémoire.

import { randomBytes } from "node:crypto";

export const LIVE_PREFIX = "mg_live_";
export const TEST_PREFIX = "mg_test_";

/** Longueur du préfixe stocké/cherché en DB (mg_test_ + 4 chars visibles). */
export const STORED_PREFIX_LEN = 12;

export interface ApiKeyRow {
  id: string;
  name: string;
  key_hash: string;
  prefix: string;
  scopes: string[] | unknown;
  revoked_at: string | null;
}

/** Génère une clé complète (affichée une seule fois) + préfixe de lookup. */
export function mintKey(testMode: boolean): { key: string; prefix: string } {
  const key = `${testMode ? TEST_PREFIX : LIVE_PREFIX}${randomBytes(18).toString("hex")}`;
  return { key, prefix: key.slice(0, STORED_PREFIX_LEN) };
}

export async function hashSecret(secret: string): Promise<string> {
  return Bun.password.hash(secret, { algorithm: "argon2id" });
}

/**
 * Vérifie une clé candidate : préfixe + Argon2 + non révoquée.
 * Retourne la ligne gagnante ou null (ne révèle jamais laquelle a échoué).
 */
export async function verifyApiKey(
  presented: string,
  candidates: ApiKeyRow[],
): Promise<ApiKeyRow | null> {
  for (const row of candidates) {
    if (row.revoked_at !== null) continue;
    try {
      if (await Bun.password.verify(presented, row.key_hash)) return row;
    } catch {
      // hash corrompu → ignore ce candidat
    }
  }
  return null;
}

/** Extrait la clé API (X-API-Key prioritaire, sinon Authorization Bearer). */
export function extractApiKey(req: Request): string | null {
  const header = req.headers.get("x-api-key")?.trim();
  if (header) return header;
  const auth = req.headers.get("authorization")?.trim() ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------- sessions

export interface Session {
  userId: string;
  email: string;
  expiresAt: number;
}

export const SESSION_COOKIE = "ps_session";

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly ttlMs: number = 12 * 3_600_000) {}

  create(userId: string, email: string): { token: string; session: Session } {
    const token = randomBytes(32).toString("hex");
    const session: Session = { userId, email, expiresAt: Date.now() + this.ttlMs };
    this.sessions.set(token, session);
    return { token, session };
  }

  get(token: string): Session | null {
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return s;
  }

  destroy(token: string): void {
    this.sessions.delete(token);
  }
}

export function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const header = req.headers.get("cookie");
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string, maxAgeSec: number): string {
  // Secure omis en local (HTTP) ; SameSite=Lax + HttpOnly + Path strict.
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

// -------------------------------------------------------------- rate limit

/** Fenêtre glissante en mémoire (par clé : identité, IP...). */
export class RateLimit {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  /** true = autorisé ; false = dépassé (429). */
  check(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) {
        if (v.length === 0 || v[v.length - 1] <= cutoff) this.hits.delete(k);
      }
    }
    return true;
  }
}
