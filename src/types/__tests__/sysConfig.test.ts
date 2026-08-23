import { describe, expect, it } from "vitest";
import { ServersResponseSchema, SysConfigSchema } from "@/types/cfsm";

describe("sysConfig.show_three_net_details", () => {
  it("defaults to on so old backends keep rendering the three-carrier lines", () => {
    // 后端 2026-08-23 才加这个字段。老版本不下发，而它们是一直输出详细 ping/loss 的，
    // 默认按 false 走会让存量站点的三网线全部消失。
    expect(SysConfigSchema.parse({}).show_three_net_details).toBe(true);
  });

  it("reads the switch when the backend does send it", () => {
    expect(SysConfigSchema.parse({ show_three_net_details: false }).show_three_net_details).toBe(
      false,
    );
    expect(SysConfigSchema.parse({ show_three_net_details: true }).show_three_net_details).toBe(
      true,
    );
  });

  it("survives a servers payload that omits sysConfig entirely", () => {
    const parsed = ServersResponseSchema.parse({ servers: [] });
    expect(parsed.sysConfig.show_three_net_details).toBe(true);
  });

  it("carries the switch through the servers payload", () => {
    const parsed = ServersResponseSchema.parse({
      servers: [],
      sysConfig: { show_three_net_details: false },
    });
    expect(parsed.sysConfig.show_three_net_details).toBe(false);
  });
});
