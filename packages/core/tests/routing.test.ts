// §18 core — routing: CD-AIRTEL priority, incompatible skipped,
// supports() local sync (never network).
import { describe, expect, test } from "bun:test";
import { resolveRoute } from "../src/engine/routing.js";
import { NoSupportedProviderError } from "../src/errors.js";
import { MockProvider } from "../src/providers/mock.js";
import type { ProviderCapabilities } from "../src/types.js";

function capsFor(
  countries: string[],
  networks: Record<string, string[]>,
): ProviderCapabilities {
  return {
    supported_countries: countries,
    supported_networks: networks,
    supported_currencies: ["CDF", "XAF"],
    min_amount_minor: 100n,
    max_amount_minor: 100000000n,
    operations: ["collect"],
    supports_idempotency: true,
  };
}

describe("static routing Country+Network → ordered list", () => {
  test("CD-AIRTEL → [pawapay, cinetpay] in priority order", () => {
    const pawapay = new MockProvider({
      code: "pawapay",
      capabilities: capsFor(["CD"], { CD: ["AIRTEL"] }),
    });
    const cinetpay = new MockProvider({
      code: "cinetpay",
      capabilities: capsFor(["CD"], { CD: ["AIRTEL"] }),
    });
    const route = resolveRoute(
      { country: "CD", network: "AIRTEL", providers: ["pawapay", "cinetpay"] },
      [pawapay, cinetpay],
      { currency: "CDF", amountMinor: 500000n },
    );
    expect(route).toEqual(["pawapay", "cinetpay"]);
  });

  test("incompatible provider is skipped, next is used", () => {
    const pawapay = new MockProvider({
      code: "pawapay",
      capabilities: capsFor(["CG"], { CG: ["AIRTEL"] }),
    });
    const cinetpay = new MockProvider({
      code: "cinetpay",
      capabilities: capsFor(["CD"], { CD: ["AIRTEL"] }),
    });
    const route = resolveRoute(
      { country: "CD", network: "AIRTEL", providers: ["pawapay", "cinetpay"] },
      [pawapay, cinetpay],
      { currency: "CDF", amountMinor: 500000n },
    );
    expect(route).toEqual(["cinetpay"]);
  });

  test("no compatible provider → NO_SUPPORTED_PROVIDER (422 at API layer)", () => {
    const pawapay = new MockProvider({
      code: "pawapay",
      capabilities: capsFor(["CG"], { CG: ["AIRTEL"] }),
    });
    expect(() =>
      resolveRoute(
        { country: "CD", network: "AIRTEL", providers: ["pawapay"] },
        [pawapay],
        { currency: "CDF", amountMinor: 500000n },
      ),
    ).toThrow(NoSupportedProviderError);
  });

  test("amount outside min/max → provider filtered out", () => {
    const pawapay = new MockProvider({
      code: "pawapay",
      capabilities: capsFor(["CD"], { CD: ["AIRTEL"] }),
    });
    expect(() =>
      resolveRoute(
        { country: "CD", network: "AIRTEL", providers: ["pawapay"] },
        [pawapay],
        { currency: "CDF", amountMinor: 1n },
      ),
    ).toThrow(NoSupportedProviderError);
  });
});

describe("supports() is sync + local", () => {
  test("returns a boolean synchronously, never a Promise", () => {
    const mock = new MockProvider({
      capabilities: capsFor(["CD"], { CD: ["AIRTEL"] }),
    });
    const params = {
      country: "CD",
      network: "AIRTEL",
      currency: "CDF",
      amountMinor: 500000n,
    };
    const result = mock.supports(params);
    expect(typeof result).toBe("boolean");
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toBe(true);
    expect(mock.supports.constructor.name).not.toBe("AsyncFunction");
  });

  test("float amounts are rejected (BIGINT only)", () => {
    const mock = new MockProvider({
      capabilities: capsFor(["CD"], { CD: ["AIRTEL"] }),
    });
    expect(
      mock.supports({
        country: "CD",
        network: "AIRTEL",
        currency: "CDF",
        amountMinor: 5000.5 as unknown as bigint,
      }),
    ).toBe(false);
  });
});
