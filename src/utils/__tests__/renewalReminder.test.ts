import { describe, expect, it } from "vitest";
import type { RenewalReminderSource } from "@/utils/renewalReminder";
import {
  getRenewalReminders,
  getVisibleRenewalReminders,
  RENEWAL_SNOOZE_MS,
  renewalCycleKey,
} from "@/utils/renewalReminder";
import { getExpireDaysRemaining } from "@/utils/format";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 6, 12, 0, 0, 0);

function inDays(days: number) {
  return new Date(NOW + days * DAY_MS).toISOString();
}

function node(overrides: Partial<RenewalReminderSource> = {}): RenewalReminderSource {
  return {
    uuid: "node-1",
    name: "Tokyo Edge",
    weight: 1,
    price: 12,
    currency: "$",
    billing_cycle: "month",
    auto_renewal: false,
    expired_at: inDays(7),
    ...overrides,
  };
}

describe("提醒窗口可配（renewalReminderDays）", () => {
  it("按传入的天数取，0 = 一条都不提醒", () => {
    const nodes = [
      node({ uuid: "d3", expired_at: inDays(3) }),
      node({ uuid: "d10", expired_at: inDays(10) }),
      node({ uuid: "d30", expired_at: inDays(30) }),
    ];
    expect(getRenewalReminders(nodes, NOW).map((r) => r.uuid)).toEqual(["d3"]);
    expect(getRenewalReminders(nodes, NOW, { warningDays: 30 }).map((r) => r.uuid)).toEqual([
      "d3",
      "d10",
      "d30",
    ]);
    expect(getRenewalReminders(nodes, NOW, { warningDays: 0 })).toEqual([]);
  });

  it("已过期的节点在 0 天窗口下也不提醒", () => {
    const nodes = [node({ uuid: "gone", expired_at: inDays(-2), online: true })];
    expect(getRenewalReminders(nodes, NOW, { warningDays: 0 })).toEqual([]);
  });
});

describe("renewal reminders", () => {
  it("keeps only nodes due within 7 days and sorts the most urgent first", () => {
    const reminders = getRenewalReminders(
      [
        node({ uuid: "later", name: "Later", expired_at: inDays(8) }),
        node({ uuid: "soon", name: "Soon", expired_at: inDays(7), auto_renewal: true }),
        node({ uuid: "urgent", name: "Urgent", expired_at: inDays(3) }),
        node({ uuid: "none", name: "No expiry", expired_at: "" }),
      ],
      NOW,
    );

    expect(reminders.map((item) => item.uuid)).toEqual(["urgent", "soon"]);
    expect(reminders[0]).toMatchObject({
      daysRemaining: 3,
      tone: "critical",
      statusLabel: "即将到期",
    });
    expect(reminders[1]).toMatchObject({
      daysRemaining: 7,
      tone: "success",
      statusLabel: "自动续费已开启",
    });
  });

  it("keeps expired reminders only for nodes confirmed online", () => {
    const reminders = getRenewalReminders(
      [
        node({ uuid: "offline-expired", expired_at: inDays(-2), online: false }),
        node({ uuid: "online-expired", expired_at: inDays(-2), online: true }),
        node({ uuid: "unknown-expired", expired_at: inDays(-2), online: null }),
        node({ uuid: "offline-soon", expired_at: inDays(3), online: false }),
      ],
      NOW,
      { requireOnlineForExpired: true },
    );
    const reminderByUuid = new Map(reminders.map((item) => [item.uuid, item]));

    expect(reminderByUuid.has("offline-expired")).toBe(false);
    expect(reminderByUuid.get("online-expired")?.statusLabel).toBe("已过期");
    expect(reminderByUuid.has("unknown-expired")).toBe(false);
    expect(reminderByUuid.get("offline-soon")?.statusLabel).toBe("即将到期");
  });

  it("keeps expired entries in the asset risk view without the online gate", () => {
    const reminders = getRenewalReminders(
      [
        node({ uuid: "offline-expired", expired_at: inDays(-2), online: false }),
        node({ uuid: "unknown-expired", expired_at: inDays(-2), online: null }),
      ],
      NOW,
    );

    expect(reminders.map((item) => item.uuid)).toEqual(["offline-expired", "unknown-expired"]);
  });

  it("snoozes reminders for exactly one day", () => {
    expect(RENEWAL_SNOOZE_MS).toBe(DAY_MS);
  });

  it("uses the same calendar-day count as cards and the assets page", () => {
    // 本地 7 月 12 日上午 9 点，到期日 7 月 15 日：差 3 个日历日，不管在哪个时区跑。
    const now = new Date(2026, 6, 12, 9, 0).getTime();
    const [reminder] = getRenewalReminders([node({ expired_at: "2026-07-15" })], now);
    expect(reminder.daysRemaining).toBe(3);
    expect(reminder.daysRemaining).toBe(getExpireDaysRemaining("2026-07-15", now));
  });

  it("binds dismissal to the exact expiry cycle", () => {
    const current = node({ expired_at: inDays(3) });
    const renewed = node({ expired_at: inDays(33) });

    expect(renewalCycleKey(current)).not.toBe(renewalCycleKey(renewed));
  });

  it("hides dismissed and currently snoozed cycles, then restores expired snoozes", () => {
    const reminders = getRenewalReminders(
      [node({ uuid: "dismiss" }), node({ uuid: "snooze" }), node({ uuid: "visible" })],
      NOW,
    );
    const key = (uuid: string) => reminders.find((item) => item.uuid === uuid)!.cycleKey;
    const preferences = {
      dismissedCycles: [key("dismiss")],
      snoozedUntil: { [key("snooze")]: NOW + DAY_MS },
    };

    expect(getVisibleRenewalReminders(reminders, preferences, NOW).map((item) => item.uuid)).toEqual([
      "visible",
    ]);
    expect(
      getVisibleRenewalReminders(reminders, preferences, NOW + 2 * DAY_MS).map((item) => item.uuid),
    ).toEqual(["snooze", "visible"]);
  });
});
