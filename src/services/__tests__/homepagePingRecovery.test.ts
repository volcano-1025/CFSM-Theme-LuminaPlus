// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPingRecords } from "@/services/api";
import {
  HOMEPAGE_RECOVERY_HISTORY_HOURS,
  HOMEPAGE_RECOVERY_SUCCESS_TTL_MS,
  hasSignificantPingGap,
  requestHomepagePingRecovery,
  resetHomepagePingRecovery,
  shouldRecoverHomepagePing,
} from "@/services/homepagePingRecovery";
import {
  getPingHistorySnapshot,
  resetPingLiveStore,
  seedPingHistory,
  type PingLiveSample,
} from "@/services/pingLiveStore";
import { EMPTY_CARRIER_PING, type CarrierPingSnapshot } from "@/types/cfsm";

vi.mock("@/services/api", () => ({
  getPingRecords: vi.fn(),
}));

const NOW = Date.UTC(2026, 6, 17, 12, 0);

function ping(values: Partial<CarrierPingSnapshot>): CarrierPingSnapshot {
  return { ...EMPTY_CARRIER_PING, ...values };
}

function at(minutesAgo: number, values: Partial<CarrierPingSnapshot> = { ct: 30 }) {
  return {
    time: NOW - minutesAgo * 60_000,
    ping: ping(values),
  } satisfies PingLiveSample;
}

function grid(startMinutesAgo: number, endMinutesAgo: number): PingLiveSample[] {
  const points: PingLiveSample[] = [];
  for (
    let minutesAgo = startMinutesAgo;
    minutesAgo >= endMinutesAgo;
    minutesAgo -= 2
  ) {
    points.push(at(minutesAgo));
  }
  return points;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(getPingRecords).mockReset();
  vi.mocked(getPingRecords).mockResolvedValue({} as Awaited<ReturnType<typeof getPingRecords>>);
  window.localStorage.clear();
  resetHomepagePingRecovery();
  resetPingLiveStore();
});

describe("hasSignificantPingGap", () => {
  it("flags a leading gap when only the latest sample remains", () => {
    expect(hasSignificantPingGap([at(2)], "ct", NOW)).toBe(true);
  });

  it("flags a leading gap when the latest two samples are otherwise adjacent", () => {
    expect(hasSignificantPingGap([at(4), at(2)], "ct", NOW)).toBe(true);
  });

  it("flags an internal hole larger than two grid steps", () => {
    const samples = [...grid(58, 54), ...grid(48, 0)];

    expect(hasSignificantPingGap(samples, "ct", NOW)).toBe(true);
  });

  it("checks the gap from now to the last sample for trailing recovery", () => {
    expect(hasSignificantPingGap(grid(58, 10), "ct", NOW)).toBe(true);
  });

  it("does not flag a complete one-hour two-minute grid", () => {
    const samples = grid(58, 0);

    expect(hasSignificantPingGap(samples, "ct", NOW)).toBe(false);
  });

  it("ignores a small off-grid tail", () => {
    const samples = [...grid(58, 4), at(3)];

    expect(hasSignificantPingGap(samples, "ct", NOW)).toBe(false);
  });

  it("does not flag a newly started node's pre-boot leading window", () => {
    expect(hasSignificantPingGap([at(1)], "ct", NOW, 5 * 60)).toBe(false);
  });

  it("does not flag an empty series", () => {
    expect(hasSignificantPingGap([], "ct", NOW)).toBe(false);
  });

  it("only considers the requested carrier", () => {
    const samples = [at(4, { cu: 20 }), at(2, { cu: 21 })];

    expect(shouldRecoverHomepagePing(samples, [1], NOW)).toBe(false);
    expect(shouldRecoverHomepagePing(samples, [2], NOW)).toBe(true);
  });

  it("does not flag a gap that local WSS samples have filled", () => {
    const samples = grid(58, 0);

    expect(shouldRecoverHomepagePing(samples, [1, 2, 3], NOW)).toBe(false);
  });
});

describe("requestHomepagePingRecovery", () => {
  it("does not request history for a normal node", async () => {
    seedPingHistory("node-a", grid(58, 0));

    await expect(requestHomepagePingRecovery("node-a", [1], NOW)).resolves.toBe(false);
    expect(getPingRecords).not.toHaveBeenCalled();
  });

  it("shares one request across three carriers and suppresses a successful short-term retry", async () => {
    seedPingHistory("node-a", [at(4), at(2)]);

    let resolveRequest!: (value: Awaited<ReturnType<typeof getPingRecords>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof getPingRecords>>>((resolve) => {
      resolveRequest = resolve;
    });
    vi.mocked(getPingRecords).mockReturnValue(pending);

    const first = requestHomepagePingRecovery("node-a", [1], NOW);
    const second = requestHomepagePingRecovery("node-a", [1, 2, 3], NOW);

    expect(getPingRecords).toHaveBeenCalledTimes(1);
    expect(getPingRecords).toHaveBeenCalledWith("node-a", HOMEPAGE_RECOVERY_HISTORY_HOURS);

    resolveRequest({} as Awaited<ReturnType<typeof getPingRecords>>);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);

    // 模拟刷新：模块内存被清掉，但浏览器侧成功标记仍然抑制短期重复请求。
    resetHomepagePingRecovery();
    await expect(requestHomepagePingRecovery("node-a", [1], NOW + 60_000)).resolves.toBe(false);
    await expect(
      requestHomepagePingRecovery(
        "node-a",
        [1],
        NOW + HOMEPAGE_RECOVERY_SUCCESS_TTL_MS - 1,
      ),
    ).resolves.toBe(false);
    expect(getPingRecords).toHaveBeenCalledTimes(1);

    await expect(
      requestHomepagePingRecovery(
        "node-a",
        [1],
        NOW + HOMEPAGE_RECOVERY_SUCCESS_TTL_MS + 1,
      ),
    ).resolves.toBe(true);
    expect(getPingRecords).toHaveBeenCalledTimes(2);
    expect(getPingHistorySnapshot("node-a")).not.toHaveLength(0);
  });

  it("does not request history when there are no valid samples", async () => {
    await expect(requestHomepagePingRecovery("new-node", [1], NOW)).resolves.toBe(false);
    expect(getPingRecords).not.toHaveBeenCalled();
  });

  it("cools down a failed request for sixty seconds", async () => {
    seedPingHistory("node-a", [at(4), at(2)]);
    vi.mocked(getPingRecords).mockRejectedValueOnce(new Error("history unavailable"));

    await expect(requestHomepagePingRecovery("node-a", [1], NOW)).resolves.toBe(false);
    await expect(
      requestHomepagePingRecovery("node-a", [1], NOW + 30_000),
    ).resolves.toBe(false);
    expect(getPingRecords).toHaveBeenCalledTimes(1);

    await expect(
      requestHomepagePingRecovery("node-a", [1], NOW + 60_001),
    ).resolves.toBe(true);
    expect(getPingRecords).toHaveBeenCalledTimes(2);
  });
});
