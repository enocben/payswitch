// Core — Network identity UNIQUE(country_id, code): CD-AIRTEL ≠ CG-AIRTEL.
import { describe, expect, test } from "bun:test";
import { createNetwork, networkKey } from "../src/domain/network.js";
import { createCountry } from "../src/domain/country.js";

describe("network identity", () => {
  test("CD-AIRTEL ≠ CG-AIRTEL", () => {
    expect(networkKey("CD", "AIRTEL")).toBe("CD-AIRTEL");
    expect(networkKey("CG", "AIRTEL")).toBe("CG-AIRTEL");
    expect(networkKey("CD", "AIRTEL")).not.toBe(networkKey("CG", "AIRTEL"));
  });

  test("keys are case-insensitive but distinct per country", () => {
    expect(networkKey("cd", "airtel")).toBe(networkKey("CD", "AIRTEL"));
  });

  test("createNetwork keeps country-qualified identity", () => {
    const a = createNetwork({ id: "n1", country_id: "CD", code: "airtel", display_name: "Airtel CD" });
    const b = createNetwork({ id: "n2", country_id: "CG", code: "airtel", display_name: "Airtel CG" });
    expect(a.code).toBe("AIRTEL");
    expect(networkKey(a.country_id, a.code)).not.toBe(networkKey(b.country_id, b.code));
  });

  test("createCountry validates ISO codes", () => {
    const c = createCountry({ id: "c1", code: "cd", name: "RDC", currency_default: "cdf" });
    expect(c.code).toBe("CD");
    expect(c.currency_default).toBe("CDF");
    expect(() => createCountry({ id: "x", code: "CDA", name: "Bad", currency_default: "CDF" })).toThrow();
  });
});
