// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPingRecords } from "@/services/api";
import {
  HOMEPAGE_RECOVERY_HISTORY_HOURS,
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
  it("does not flag a complete two-minute grid", () => {
    const samples = Array.from({ length: 30 }, (_, index) => at(58 - index * 2));

    expect(hasSignificantPingGap(samples, "ct", NOW)).toBe(false);
  });

  it("flags an internal hole but ignores the normal off-grid tail", () => {
    const internalHole = [at(50), at(48), at(46), at(30), at(28), at(26), at(4)];
    const normalTail = [at(12), at(10), at(8), at(3)];
    const oneMissingGrid = [at(20), at(18), at(14), at(12)];

    expect(hasSignificantPingGap(internalHole, "ct", NOW)).toBe(true);
    expect(hasSignificantPingGap(normalTail, "ct", NOW)).toBe(false);
    expect(hasSignificantPingGap(oneMissingGrid, "ct", NOW)).toBe(false);
  });

  it("only considers the requested carrier", () => {
    const samples = [
      at(30, { cu: 20 }),
      at(28, { cu: 21 }),
      at(10, { cu: 22 }),
    ];

    expect(shouldRecoverHomepagePing(samples, [1], NOW)).toBe(false);
    expect(shouldRecoverHomepagePing(samples, [2], NOW)).toBe(true);
  });

  it("does not flag a gap that local WSS samples have filled", () => {
    const samples = [at(30), at(28), at(26), at(24), at(22), at(20), at(18), at(16)];

    expect(shouldRecoverHomepagePing(samples, [1, 2, 3], NOW)).toBe(false);
  });
});

describe("requestHomepagePingRecovery", () => {
  it("does not request history for a normal node", async () => {
    seedPingHistory("node-a", [at(30), at(28), at(26), at(24)]);

    await expect(requestHomepagePingRecovery("node-a", [1], NOW)).resolves.toBe(false);
    expect(getPingRecords).not.toHaveBeenCalled();
  });

  it("shares one request and suppresses a successful short-term retry", async () => {
    seedPingHistory("node-a", [at(50), at(48), at(46), at(30), at(28), at(26), at(4)]);

    let resolveRequest!: (value: Awaited<ReturnType<typeof getPingRecords>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof getPingRecords>>>((resolve) => {
      resolveRequest = resolve;
    });
    vi.mocked(getPingRecords).mockReturnValue(pending);

    const first = requestHomepagePingRecovery("node-a", [1], NOW);
    const second = requestHomepagePingRecovery("node-a", [1], NOW);

    expect(getPingRecords).toHaveBeenCalledTimes(1);
    expect(getPingRecords).toHaveBeenCalledWith("node-a", HOMEPAGE_RECOVERY_HISTORY_HOURS);

    resolveRequest({} as Awaited<ReturnType<typeof getPingRecords>>);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);

    // 模拟刷新：模块内存被清掉，但浏览器侧成功标记仍然抑制短期重复请求。
    resetHomepagePingRecovery();
    await expect(requestHomepagePingRecovery("node-a", [1], NOW + 60_000)).resolves.toBe(false);
    expect(getPingRecords).toHaveBeenCalledTimes(1);
    expect(getPingHistorySnapshot("node-a")).not.toHaveLength(0);
  });
});
