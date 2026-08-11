import { describe, expect, it } from "vitest";
import type { PingOverviewBucket } from "@/types/cfsm";
import {
  healthBarInteractionModel,
  healthBarSlotModel,
} from "@/components/node/nodeCardShared";

function bucket(value: number | null, loss: number | null = 0): PingOverviewBucket {
  return {
    index: 0,
    value,
    loss,
    total: value == null ? 0 : 1,
    lost: 0,
    startAt: null,
    endAt: null,
  };
}

describe("healthBarSlotModel", () => {
  it("keeps every valid latency bucket at one height while color carries severity", () => {
    const values = [0, 20, 55, 88.5, 151, 400];
    const slots = values.map((value) => healthBarSlotModel(bucket(value), "latency"));

    expect(slots.every((slot) => slot.active)).toBe(true);
    expect(new Set(slots.map((slot) => slot.heightFraction))).toEqual(new Set([0.84]));
    expect(slots.map((slot) => slot.color)).toEqual([
      "var(--latency-excellent)",
      "var(--latency-excellent)",
      "var(--latency-excellent)",
      "var(--latency-good)",
      "var(--latency-moderate)",
      "var(--latency-critical)",
    ]);
  });

  it("renders missing latency as a short neutral gap", () => {
    expect(healthBarSlotModel(bucket(null, null), "latency")).toMatchObject({
      active: false,
      heightFraction: 0.25,
      color: "var(--progress-bg)",
    });
  });

  it("keeps loss buckets on the same fixed-height visual language", () => {
    expect(healthBarSlotModel(bucket(20), "latency")).toMatchObject({
      active: true,
      heightFraction: 0.84,
      alpha: 0.94,
    });
    expect(healthBarSlotModel(bucket(20, 12.5), "loss")).toMatchObject({
      active: true,
      heightFraction: 0.84,
      alpha: 0.94,
    });
  });

  it("uses the shared hover lift and sibling fade for canvas renderers", () => {
    const slot = healthBarSlotModel(bucket(55), "latency");

    expect(healthBarInteractionModel(slot, true, 1)).toMatchObject({
      heightFraction: 1,
      alpha: 1,
    });
    expect(healthBarInteractionModel(slot, false, 1).alpha).toBeCloseTo(slot.alpha * 0.54);
    expect(healthBarInteractionModel(slot, true, 0)).toMatchObject({
      heightFraction: slot.heightFraction,
      alpha: slot.alpha,
    });
  });
});
