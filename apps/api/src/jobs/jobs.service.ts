// @payswitch/api — jobs queue (spec §9.2, §8.2, US-11).
// Jamais bloquant HTTP : polling verify() + expiration + flush sortant.
// Erreurs isolées par paiement dans le moteur ; tick chevauché interdit.
// (BullMQ/Redis : vague ultérieure ; @nestjs/schedule en v1.)

import { Inject, Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import type { PaymentEngine } from "../engine/payment-engine";
import { LIVE_ENGINE, TEST_ENGINE } from "../engine/engine.provider";
import { MerchantWebhooksService } from "../modules/merchant-webhooks/merchant-webhooks.service";

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  private running = false;

  constructor(
    @Inject(TEST_ENGINE) private readonly testEngine: PaymentEngine,
    @Inject(LIVE_ENGINE) private readonly liveEngine: PaymentEngine,
    private readonly deliveries: MerchantWebhooksService,
  ) {}

  /** Tick 15s : polling verify() puis expiration, TEST puis LIVE. */
  @Cron("*/15 * * * * *")
  async pollTick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      for (const engine of [this.testEngine, this.liveEngine]) {
        const polled = await engine.pollDue(now).catch((err) => ({ checked: 0, settled: 0, error: String(err) }));
        const expired = await engine.expireDue(now).catch(() => ({ expired: 0, unknown: 0 }));
        void polled;
        void expired;
      }
      await this.deliveries.flush(now).catch((err) => this.logger.warn(`delivery flush failed: ${String(err)}`));
    } finally {
      this.running = false;
    }
  }
}
