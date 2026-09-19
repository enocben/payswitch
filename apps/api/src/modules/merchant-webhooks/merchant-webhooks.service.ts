// @payswitch/api — webhooks sortants vers marchand (spec §8.2, US-10).
// event_id + attempt_id + HMAC-SHA256 (X-Webhook-Signature, X-Event-Id),
// retry WEBHOOK_RETRY_SCHEDULE / WEBHOOK_MAX_RETRIES, Replay = ré-enqueue.

import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { PaymentEngine } from "../../engine/payment-engine";
import { TEST_ENGINE } from "../../engine/engine.provider";
import type { WebhookSender } from "../../engine/webhook-outbound";
import { PayswitchConfig } from "../../config/payswitch-config";
import { TypeOrmStore } from "../../infrastructure/database/typeorm-store";
import { EnqueueDeliveryDto } from "./dto/delivery.dto";

/** Sender HTTP réel (fetch + timeout 10s) ; 2xx = livré. */
export const httpWebhookSender: WebhookSender = async (url, body, headers) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text().catch(() => "");
  return { statusCode: res.status, body: text.slice(0, 2000) };
};

@Injectable()
export class MerchantWebhooksService {
  constructor(
    @Inject(TEST_ENGINE) private readonly engine: PaymentEngine,
    @Inject(TypeOrmStore) private readonly store: TypeOrmStore,
    @Inject(PayswitchConfig) private readonly cfg: PayswitchConfig,
  ) {}

  // enqueueMerchantDelivery ne fait aucun appel provider : l'instance TEST
  // et LIVE sont interchangeables ici (même store). TEST par convention.
  enqueue(dto: EnqueueDeliveryDto) {
    return this.engine.enqueueMerchantDelivery({
      paymentId: dto.payment_id,
      url: dto.url,
      secret: dto.secret,
      eventType: dto.event_type,
      attemptId: dto.attempt_id,
    });
  }

  list(limit = 50) {
    return this.store.listDeliveries(Math.min(limit, 200));
  }

  /** Replay dashboard : nouvelle delivery (nouvel event_id) pour le même paiement. */
  async replay(id: string, secret: string) {
    const existing = await this.store.findDeliveryById(id);
    if (!existing) throw new NotFoundException(`Delivery not found: ${id}`);
    return this.engine.enqueueMerchantDelivery({
      paymentId: existing.payment_id,
      url: existing.url,
      secret,
      eventType: existing.event_type,
      attemptId: existing.attempt_id ?? undefined,
    });
  }

  /** Flush queue (jobs) : 2xx → delivered, sinon retrying/failed. */
  flush(now = new Date()) {
    return this.engine.processDueDeliveries(now, httpWebhookSender, {
      scheduleRaw: this.cfg.webhookRetryScheduleRaw,
      maxRetriesRaw: this.cfg.webhookMaxRetriesRaw,
    });
  }
}
