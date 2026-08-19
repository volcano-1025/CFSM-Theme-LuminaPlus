import { describe, expect, it } from "vitest";
import {
  RECENT_REFRESH_WINDOW_MS,
  shouldRemindRecentRefresh,
} from "@/hooks/usePingHistoryRefresh";

const NOW = Date.UTC(2026, 7, 19, 12, 0);

describe("30 分钟内重复刷新的提醒判定", () => {
  it("从没刷新过时不提醒", () => {
    expect(shouldRemindRecentRefresh(null, NOW)).toBe(false);
  });

  it("刚刷完又点，提醒", () => {
    expect(shouldRemindRecentRefresh(NOW - 30_000, NOW)).toBe(true);
    expect(shouldRemindRecentRefresh(NOW - 29 * 60_000, NOW)).toBe(true);
  });

  it("满 30 分钟就放行，不再提醒", () => {
    expect(shouldRemindRecentRefresh(NOW - RECENT_REFRESH_WINDOW_MS, NOW)).toBe(false);
    expect(shouldRemindRecentRefresh(NOW - RECENT_REFRESH_WINDOW_MS - 1, NOW)).toBe(false);
  });

  it("窗口就是 30 分钟", () => {
    expect(RECENT_REFRESH_WINDOW_MS).toBe(30 * 60 * 1000);
  });

  it("时钟被往回调过（上次刷新在未来）不提醒，否则会永久卡住", () => {
    expect(shouldRemindRecentRefresh(NOW + 60 * 60_000, NOW)).toBe(false);
  });
});
