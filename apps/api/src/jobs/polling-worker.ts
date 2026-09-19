// @payswitch/api — worker polling/expiration (spec §9.2 steps 5-6, US-11).
// Boucle hors requête HTTP (jamais bloquant) : due → verify() via engine,
// expirés → expired/unknown. Erreurs isolées, tick chevauché interdit.
// (BullMQ/Redis : vague ultérieure ; le transport reste le même engine.)

import type { PaymentEngine } from "../engine/payment-engine.js";

export interface PollingWorkerOptions {
  engine: PaymentEngine;
  /** ms entre deux ticks (défaut 15s). */
  intervalMs?: number;
  batchSize?: number;
  onTick?: (summary: { checked: number; settled: number; expired: number; unknown: number }) => void;
  onError?: (err: unknown) => void;
}

export class PollingWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly opts: PollingWorkerOptions) {}

  start(): void {
    if (this.timer) return;
    const interval = this.opts.intervalMs ?? 15_000;
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Un tick : polling puis expiration, jamais de throw vers l'appelant. */
  async tick(now = new Date()): Promise<void> {
    if (this.running) return; // pas de chevauchement
    this.running = true;
    try {
      const batch = this.opts.batchSize ?? 50;
      const polled = await this.opts.engine.pollDue(now, batch);
      const expired = await this.opts.engine.expireDue(now, batch);
      this.opts.onTick?.({ ...polled, ...expired });
    } catch (err) {
      this.opts.onError?.(err);
    } finally {
      this.running = false;
    }
  }
}
