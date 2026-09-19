// @payswitch/api — webhooks entrants provider (spec §8.1, US-09).
// POST /webhooks/:provider (public) : signature AVANT normalisation → 403 ;
// doublon UNIQUE → 200 idempotent ; final expired/unknown → is_late + AuditLog
// → 200 ; sinon transaction → 200. Erreur DB temporaire → 500 (retry provider).

import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Request } from "express";
import type { PaymentEngine } from "../../engine/payment-engine";
import { LIVE_ENGINE, TEST_ENGINE } from "../../engine/engine.provider";
import type { ProviderRegistry } from "../../config/providers";
import { PAYMENT_PROVIDERS } from "../../config/providers";
import { requestIdOf } from "../../common/request-id.middleware";

@Injectable()
export class InboundWebhooksService {
  constructor(
    @Inject(TEST_ENGINE) private readonly testEngine: PaymentEngine,
    @Inject(LIVE_ENGINE) private readonly liveEngine: PaymentEngine,
    @Inject(PAYMENT_PROVIDERS) private readonly registry: ProviderRegistry,
  ) {}

  async handle(provider: string, req: Request): Promise<{ body: Record<string, unknown>; status: number }> {
    const code = provider.toLowerCase();
    const engine = this.registry.test.has(code)
      ? this.testEngine
      : this.registry.live.has(code)
        ? this.liveEngine
        : null;
    if (!engine) throw new NotFoundException(`Unknown provider: ${provider}`);
    const rawBody = (req as unknown as { rawBody?: string }).rawBody ?? "";
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k.toLowerCase()] = v;
    }
    const outcome = await engine.applyInboundWebhook(code, rawBody, headers, {
      ip: req.ip,
      requestId: requestIdOf(req),
    });
    return { status: outcome.httpStatus, body: { result: outcome.result, payment_id: outcome.payment_id ?? null } };
  }
}
