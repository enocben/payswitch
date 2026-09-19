// @payswitch/api — request_id / correlation_id (spec §7.1).
// Un uuid7 par requête → res.header X-Request-Id + req tracé dans les logs
// et propagé au moteur (request_id, correlation_id).

import { Injectable, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { uuidv7 } from "./ids";

/** Fonction middleware (utilisée dans main.ts, sans DI). */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header("X-Request-Id");
  const requestId =
    typeof incoming === "string" && incoming.length > 0 ? incoming : uuidv7();
  (req as unknown as { requestId?: string }).requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    requestIdMiddleware(req, res, next);
  }
}

/** Lit le request_id posé par le middleware (fallback uuid7 hors HTTP). */
export function requestIdOf(req: unknown): string {
  const id = (req as { requestId?: unknown } | null)?.requestId;
  return typeof id === "string" && id.length > 0 ? id : uuidv7();
}
