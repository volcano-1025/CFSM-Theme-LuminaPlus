export interface NodeTodayTrafficPopoverState {
  hovered: boolean;
  pinned: boolean;
  focusWithin: boolean;
}

export type NodeTodayTrafficPopoverAction =
  | { type: "hover-open" }
  | { type: "hover-close" }
  | { type: "focus-enter" }
  | { type: "focus-leave" }
  | { type: "toggle-pin" }
  | { type: "close-all" };

export const INITIAL_NODE_TODAY_TRAFFIC_POPOVER_STATE: NodeTodayTrafficPopoverState = {
  hovered: false,
  pinned: false,
  focusWithin: false,
};

export function nodeTodayTrafficPopoverReducer(
  state: NodeTodayTrafficPopoverState,
  action: NodeTodayTrafficPopoverAction,
): NodeTodayTrafficPopoverState {
  switch (action.type) {
    case "hover-open":
      return state.hovered ? state : { ...state, hovered: true };
    case "hover-close":
      return state.hovered ? { ...state, hovered: false } : state;
    case "focus-enter":
      return state.focusWithin ? state : { ...state, focusWithin: true };
    case "focus-leave":
      return state.focusWithin ? { ...state, focusWithin: false } : state;
    case "toggle-pin":
      // 二次点击必须清掉 hover/focus，避免触屏按钮仍聚焦时无法关闭。
      return state.pinned
        ? INITIAL_NODE_TODAY_TRAFFIC_POPOVER_STATE
        : { ...state, pinned: true };
    case "close-all":
      return INITIAL_NODE_TODAY_TRAFFIC_POPOVER_STATE;
  }
}

export function isNodeTodayTrafficPopoverOpen(
  state: NodeTodayTrafficPopoverState,
) {
  return state.hovered || state.pinned || state.focusWithin;
}

export function consumeTriggerFocusSuppression(suppression: { current: boolean }) {
  if (!suppression.current) return false;
  suppression.current = false;
  return true;
}
