import { describe, expect, it } from "vitest";
import {
  consumeTriggerFocusSuppression,
  INITIAL_NODE_TODAY_TRAFFIC_POPOVER_STATE,
  isNodeTodayTrafficPopoverOpen,
  nodeTodayTrafficPopoverReducer,
} from "@/components/node/nodeTodayTrafficPopoverState";

describe("node today traffic popover state", () => {
  it("fully closes on the second touch/click even if hover and focus are still set", () => {
    const openState = {
      hovered: true,
      focusWithin: true,
      pinned: true,
    };

    const closed = nodeTodayTrafficPopoverReducer(openState, { type: "toggle-pin" });

    expect(closed).toEqual(INITIAL_NODE_TODAY_TRAFFIC_POPOVER_STATE);
    expect(isNodeTodayTrafficPopoverOpen(closed)).toBe(false);
  });

  it("keeps keyboard focus independent from hover and pin state", () => {
    const focused = nodeTodayTrafficPopoverReducer(
      INITIAL_NODE_TODAY_TRAFFIC_POPOVER_STATE,
      { type: "focus-enter" },
    );
    const hoverClosed = nodeTodayTrafficPopoverReducer(focused, {
      type: "hover-close",
    });

    expect(isNodeTodayTrafficPopoverOpen(hoverClosed)).toBe(true);
    expect(
      isNodeTodayTrafficPopoverOpen(
        nodeTodayTrafficPopoverReducer(hoverClosed, { type: "focus-leave" }),
      ),
    ).toBe(false);
  });

  it("consumes Esc focus restoration suppression exactly once", () => {
    const suppression = { current: true };

    expect(consumeTriggerFocusSuppression(suppression)).toBe(true);
    expect(suppression.current).toBe(false);
    expect(consumeTriggerFocusSuppression(suppression)).toBe(false);
  });
});
