import { describe, expect, it } from "vitest";
import { resolveTrafficTotal, resolveWsNodeIntervalMs } from "@/services/wsStore";

// 像 resolveTrafficTotals 每个 tick 那样,把一串原始累计读数喂给 resolver:把上一个显示值
//(store 存在 node metrics 上)往后传。
function drive(readings: number[]): number[] {
  let previous = 0;
  return readings.map((raw) => {
    previous = resolveTrafficTotal(previous, raw);
    return previous;
  });
}

describe("resolveTrafficTotal", () => {
  it("passes the backend counter through unchanged while it climbs", () => {
    expect(drive([10, 20, 30])).toEqual([10, 20, 30]);
  });

  it("holds the previous value when a tick reports zero (missing/partial sample)", () => {
    // 读到 0 是 offline/heartbeat 帧或漏了 net_total_up/down 的 payload,不是真实流量。
    // 保持上一个值能避免闪烁到 0,也(这正是我们要防的回归)避免真实读数回来时重复抬高总量:
    // 概览以前每次 offline 抖动都会大致翻倍。
    expect(drive([50, 0, 51])).toEqual([50, 50, 51]);
  });

  it("stays stable across repeated zero readings", () => {
    expect(drive([50, 0, 0, 51, 0, 52])).toEqual([50, 50, 50, 51, 51, 52]);
  });

  it("follows a genuine counter reset down (reboot / billing-cycle rollover)", () => {
    // 后端计数器合理下降;我们如实透传,让概览和流量限额条跟随后端而不是停在虚高值。
    expect(drive([50, 5, 6])).toEqual([50, 5, 6]);
  });

  it("ignores a zero gap but still follows a later real reset", () => {
    // 50 → offline(0,保持)→ 重置后带一个小的真实计数回来。
    expect(drive([50, 0, 2, 3])).toEqual([50, 50, 2, 3]);
  });

  it("does not surface a value until a real reading arrives", () => {
    expect(drive([0, 0, 10])).toEqual([0, 0, 10]);
  });
});

describe("resolveWsNodeIntervalMs", () => {
  /** 造一串到达时刻：每 gap 毫秒到一次，每次到 frames 帧（同一时刻）。 */
  const arrivals = (gap: number, frames: number, bursts: number) => {
    const out: number[] = [];
    for (let i = 0; i < bursts; i += 1) {
      for (let f = 0; f < frames; f += 1) out.push(i * gap);
    }
    return out;
  };

  it("matches the arrival gap when a node sends one frame at a time", () => {
    // 2 秒来 1 帧 → 2 秒显示一帧。
    expect(resolveWsNodeIntervalMs(arrivals(2_000, 1, 6))).toBe(2_000);
  });

  it("halves the interval when a node sends two frames per arrival", () => {
    // 2 秒来 2 帧 → 恒定 1 秒一帧（关键：不随队列深度忽快忽慢）。
    expect(resolveWsNodeIntervalMs(arrivals(2_000, 2, 6))).toBe(1_000);
  });

  it("spreads a batched slow node evenly", () => {
    // 6 秒来 3 帧 → 恒定 2 秒一帧，而不是"挤着放完再干等"。
    expect(resolveWsNodeIntervalMs(arrivals(6_000, 3, 5))).toBe(2_000);
  });

  it("counts frames after the first timestamp so bursts are not overcounted", () => {
    // 成簇到达时同一时刻有多帧；若用 length-1 作分母会算成 909ms，放帧比到达快就会积压。
    expect(resolveWsNodeIntervalMs(arrivals(2_000, 2, 6))).toBe(1_000);
  });

  it("paces a faster node by its own rate, independent of others", () => {
    expect(resolveWsNodeIntervalMs(arrivals(1_100, 1, 8))).toBe(1_100);
  });

  it("falls back to the default before a rate can be measured", () => {
    expect(resolveWsNodeIntervalMs([])).toBe(1_000);
    expect(resolveWsNodeIntervalMs([123])).toBe(1_000);
  });

  it("clamps so playback never storms or stalls", () => {
    expect(resolveWsNodeIntervalMs([0, 50])).toBe(200);
    expect(resolveWsNodeIntervalMs([0, 60_000])).toBe(3_000);
  });
});
