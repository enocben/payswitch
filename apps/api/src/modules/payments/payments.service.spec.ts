// @payswitch/api — PaymentsService : conversion minor, statuts 201/200,
// détail = même état que le webhook (US-02). Moteur réel sur MemoryStore.

import { Test, TestingModule } from "@nestjs/testing";
import { MockProvider, type PaymentProvider } from "@payswitch/core";
import { PaymentEngine } from "../../engine/payment-engine";
import { LIVE_ENGINE, TEST_ENGINE } from "../../engine/engine.provider";
import { MemoryStore, seedMemory } from "../../../tests/memory-store";
import { PaymentsService } from "./payments.service";
import { TypeOrmStore } from "../../infrastructure/database/typeorm-store";

function mocks(): Map<string, PaymentProvider> {
  const caps = {
    supported_countries: ["CD"],
    supported_networks: { CD: ["AIRTEL"] },
    supported_currencies: ["CDF"],
    min_amount_minor: 100n,
    max_amount_minor: 100_000_000n,
    operations: ["collect"] as const,
    supports_idempotency: true,
  };
  return new Map([
    ["mockprimary", new MockProvider({ code: "mockprimary", capabilities: { ...caps, operations: ["collect"] }, scenario: "success" })],
    ["mocksecondary", new MockProvider({ code: "mocksecondary", capabilities: { ...caps, operations: ["collect"] }, scenario: "success" })],
  ]);
}

const req = { apiKey: { name: "spec", mode: "test", scopes: [], testMode: true }, requestId: "req-spec-1" };

describe("PaymentsService", () => {
  let service: PaymentsService;
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore();
    seedMemory(store);
    // detail() résout les codes via ids — MemoryStore ne connaît que les ports.
    Object.assign(store, {
      findCountryById: async () => ({ id: "c", code: "CD", name: "RDC", currency_default: "CDF" }),
      findNetworkById: async () => ({ id: "n", country_id: "c", code: "AIRTEL", display_name: "Airtel RDC" }),
    });
    const providers = mocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: TEST_ENGINE, useValue: new PaymentEngine({ store, providers, expirationHoursRaw: "24" }) },
        { provide: LIVE_ENGINE, useValue: new PaymentEngine({ store, providers: new Map(), expirationHoursRaw: "24" }) },
        { provide: TypeOrmStore, useValue: store },
      ],
    }).compile();
    service = module.get(PaymentsService);
  });

  it("create → 201, 5000 CDF = 500000 minor, provider mockprimary", async () => {
    const dto = {
      amount: "5000",
      currency: "CDF",
      phone: "+243810000001",
      country: "CD",
      network: "AIRTEL",
      idempotency_key: "spec-key-1",
    };
    const { body, status } = await service.create(dto, req);
    expect(status).toBe(201);
    expect(body.amount_minor).toBe(500000);
    expect(body.provider).toBe("mockprimary");
    expect(body.currency).toBe("CDF");
  });

  it("GET :id expose le même état (US-02)", async () => {
    const dto = {
      amount: "5000",
      currency: "CDF",
      phone: "+243810000002",
      country: "CD",
      network: "AIRTEL",
      idempotency_key: "spec-key-2",
    };
    const { body } = await service.create(dto, req);
    const detail = (await service.getById(body.id as string)) as { status: string; phone_masked: string };
    expect(detail.status).toBe(body.status);
    expect(detail.phone_masked).toContain("****");
  });
});
