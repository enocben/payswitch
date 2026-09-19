import { describe, expect, test } from "bun:test";
import { formatMinor, fractionFor, inputToIso, maskPhone } from "../src/lib/format";
import { buildUrl, normalizeBuckets } from "../src/lib/api";

describe("maskPhone", () => {
  test("masks a DRC number keeping prefix + last 3", () => {
    expect(maskPhone("+243815556678")).toBe("+243****678");
  });
  test("passes already-masked values through", () => {
    expect(maskPhone("+243****678")).toBe("+243****678");
  });
  test("handles empty input", () => {
    expect(maskPhone(null)).toBe("—");
    expect(maskPhone("")).toBe("—");
  });
});

describe("amounts (minor units are the source of truth)", () => {
  test("XAF/XOF/UGX have 0 fraction digits", () => {
    expect(fractionFor("XAF")).toBe(0);
    expect(fractionFor("CDF")).toBe(2);
  });
  test("formatMinor embeds the raw minor value", () => {
    expect(formatMinor(500000, "CDF")).toContain("500000");
    expect(formatMinor(2500, "XAF")).toContain("2500");
  });
});

describe("api helpers", () => {
  test("buildUrl joins base + path", () => {
    expect(buildUrl("/api/v1/payments", "http://localhost:3000/")).toBe(
      "http://localhost:3000/api/v1/payments",
    );
  });
  test("normalizeBuckets accepts arrays and record maps", () => {
    expect(normalizeBuckets([{ key: "CD", totalMinor: 10, count: 1 }])).toHaveLength(1);
    expect(normalizeBuckets({ CD: 10 })).toEqual([{ key: "CD", totalMinor: 10, count: 0 }]);
    expect(normalizeBuckets(undefined)).toEqual([]);
  });
  test("inputToIso parses datetime-local values", () => {
    expect(inputToIso("")).toBeUndefined();
    expect(inputToIso("2026-09-19T12:00")?.startsWith("2026-09-19")).toBe(true);
  });
});
