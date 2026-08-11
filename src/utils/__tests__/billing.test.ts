import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatBillingCycle, formatRenewalPrice } from "@/utils/billing";

function inDays(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

describe("formatBillingCycle", () => {
  it("maps known day-counts to labels", () => {
    expect(formatBillingCycle(30)).toBe("月");
    expect(formatBillingCycle(90)).toBe("季");
    expect(formatBillingCycle(180)).toBe("半年");
    expect(formatBillingCycle(365)).toBe("年");
    expect(formatBillingCycle(360)).toBe("年");
  });

  it("renders whole-year multiples", () => {
    expect(formatBillingCycle(730)).toBe("2年");
    expect(formatBillingCycle(1095)).toBe("3年");
  });

  it("treats -1 as a lifetime cycle (regression)", () => {
    expect(formatBillingCycle(-1)).toBe("永久");
  });

  it("does not render unset cycles as 0天 (regression)", () => {
    expect(formatBillingCycle("")).toBe("年");
    expect(formatBillingCycle(null)).toBe("年");
    expect(formatBillingCycle(undefined)).toBe("年");
    expect(formatBillingCycle(0)).toBe("年");
  });

  it("maps textual cycles", () => {
    expect(formatBillingCycle("monthly")).toBe("月");
    expect(formatBillingCycle("年")).toBe("年");
    expect(formatBillingCycle("lifetime")).toBe("永久");
  });

  it("maps Chinese payment-cycle idioms (regression)", () => {
    expect(formatBillingCycle("月付")).toBe("月");
    expect(formatBillingCycle("季付")).toBe("季");
    expect(formatBillingCycle("半年付")).toBe("半年");
    expect(formatBillingCycle("年付")).toBe("年");
    expect(formatBillingCycle("Semi-Annually")).toBe("半年");
    expect(formatBillingCycle("semiannually")).toBe("半年");
  });

  it("falls back to a day-count for arbitrary positive numbers", () => {
    expect(formatBillingCycle(45)).toBe("45天");
  });
});

describe("formatRenewalPrice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders -1 prices as free", () => {
    expect(formatRenewalPrice({ price: -1, currency: "¥", billing_cycle: 365 })).toBe("免费");
  });

  it("renders zero prices as free only for long-term expiry", () => {
    expect(
      formatRenewalPrice({
        price: 0,
        currency: "¥",
        billing_cycle: 365,
        expired_at: inDays(40_000),
      }),
    ).toBe("免费");
    expect(
      formatRenewalPrice({
        price: 0,
        currency: "¥",
        billing_cycle: 365,
        expired_at: inDays(30),
      }),
    ).toBeNull();
  });

  it("renders positive prices with currency and billing cycle", () => {
    expect(formatRenewalPrice({ price: 10, currency: "$", billing_cycle: 30 })).toBe("$10/月");
    expect(formatRenewalPrice({ price: 19.9, currency: "¥", billing_cycle: -1 })).toBe("¥19.90/永久");
  });
});
