// @payswitch/api — PaymentsService (spec §7).
// Compose le moteur pur (jamais `new` ici : engines injectés) + TypeOrmStore.
// TEST (mg_test_) = mocks ; LIVE = réel ou 422 (v1 : aucun réel → 422).

import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { hashPhone, maskPhone } from "../../engine/phone";
import type { PaymentEngine } from "../../engine/payment-engine";
import { LIVE_ENGINE, TEST_ENGINE } from "../../engine/engine.provider";
import { TypeOrmStore } from "../../infrastructure/database/typeorm-store";
import { toMinor } from "../../config/currency";
import { uuidv7 } from "../../common/ids";
import { requestIdOf } from "../../common/request-id.middleware";
import { apiKeyOf } from "../api-keys/api-key.guard";
import { CreatePaymentDto } from "./dto/create-payment.dto";
import { ListPaymentsDto } from "./dto/list-payments.dto";

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(TEST_ENGINE) private readonly testEngine: PaymentEngine,
    @Inject(LIVE_ENGINE) private readonly liveEngine: PaymentEngine,
    @Inject(TypeOrmStore) private readonly store: TypeOrmStore,
  ) {}

  private engineFor(req: unknown): PaymentEngine {
    return apiKeyOf(req).testMode ? this.testEngine : this.liveEngine;
  }

  async create(dto: CreatePaymentDto, req: unknown): Promise<{ body: Record<string, unknown>; status: 200 | 201 }> {
    const requestId = requestIdOf(req);
    const currency = dto.currency.toUpperCase();
    const amountMinor = toMinor(String(dto.amount), currency);
    const engine = this.engineFor(req);
    const { payment, httpStatus } = await engine.create({
      amount_minor: amountMinor,
      currency,
      phone: dto.phone,
      country: dto.country,
      network: dto.network,
      idempotency_key: dto.idempotency_key,
      external_reference: dto.external_reference,
      metadata: dto.metadata,
      correlation_id: uuidv7(),
      request_id: requestId,
    });
    const settled = httpStatus === 201 ? await engine.initiate(payment.id) : payment;
    const detail = await this.detail(settled.id);
    return {
      status: httpStatus,
      body: {
        id: detail.id,
        status: detail.status,
        amount_minor: detail.amount_minor,
        currency: detail.currency,
        provider: detail.provider,
        external_reference: detail.external_reference,
        request_id: requestId,
      },
    };
  }

  async getById(id: string): Promise<Record<string, unknown>> {
    const found = await this.store.findPaymentById(id);
    if (!found) throw new NotFoundException(`Payment not found: ${id}`);
    return this.detail(id);
  }

  async list(dto: ListPaymentsDto): Promise<{ data: Record<string, unknown>[]; meta: Record<string, unknown> }> {
    const page = dto.page ?? 1;
    const perPage = dto.per_page ?? 20;
    const { rows, total } = await this.store.listPaymentsByFilter({
      status: dto.status,
      country: dto.country?.toUpperCase(),
      network: dto.network?.toUpperCase(),
      providerCode: dto.provider,
      phoneHash: dto.phone ? hashPhone(dto.phone) : undefined,
      externalReference: dto.external_reference,
      from: dto.from ? new Date(dto.from) : undefined,
      to: dto.to ? new Date(dto.to) : undefined,
      page,
      perPage,
    });
    const data = await Promise.all(rows.map((r) => this.detail(r.id)));
    return { data, meta: { total, page, per_page: perPage } };
  }

  /** Même état final que le webhook marchand (spec US-02). */
  async detail(id: string): Promise<Record<string, unknown>> {
    const p = await this.store.findPaymentById(id);
    if (!p) throw new NotFoundException(`Payment not found: ${id}`);
    const country = await this.store.findCountryById(p.country_id);
    const network = await this.store.findNetworkById(p.network_id);
    const attempts = await this.store.listAttempts(id);
    const enriched = await Promise.all(
      attempts.map(async (a) => ({
        attempt_number: a.attempt_number,
        status: a.status,
        provider: await this.store.findProviderCodeById(a.provider_id),
        provider_reference: a.provider_reference,
        provider_idempotency_key: a.provider_idempotency_key,
        error_code: a.error_code,
        error_message: a.error_message,
        error_outcome: a.error_outcome,
        confirmed: a.confirmed,
      })),
    );
    const withRef = [...enriched].reverse().find((a) => a.provider_reference);
    return {
      id: p.id,
      idempotency_key: p.idempotency_key,
      external_reference: p.external_reference,
      amount_minor: Number(p.amount_minor),
      currency: p.currency,
      phone_masked: maskPhone(p.phone),
      country: country?.code ?? p.country_id,
      network: network?.code ?? p.network_id,
      status: p.status,
      provider: withRef?.provider ?? null,
      provider_reference: withRef?.provider_reference ?? null,
      attempts: enriched,
      metadata: p.metadata,
      correlation_id: p.correlation_id,
    };
  }
}
