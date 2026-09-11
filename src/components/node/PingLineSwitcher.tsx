import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Check, RotateCcw } from "lucide-react";
import {
  useAvailablePingTaskIds,
  useNodePingLineOverrides,
} from "@/hooks/usePingOverview";
import { useCarrierNames } from "@/hooks/usePublicConfig";
import { useThemeSettings } from "@/hooks/useThemeSettings";
import { CARRIER_TASKS, carrierTaskName } from "@/services/cfsm/mappers";
import { setPingLineOverrides } from "@/services/pingLineOverrideStore";
import {
  EMPTY_PING_LINE_OVERRIDES,
  nodePingLineOverrides,
  resolveNodePingLineTaskIds,
  switchPingLine,
} from "@/utils/pingLineOverrides";

/** 浮层和线路名之间的空隙，与实例切换器 / 排序浮层的 `calc(100% + 6px)` 一致。 */
const PANEL_GAP_PX = 6;
/** 浮层离视口边缘至少留这么多：手机上贴边的卡片不能把菜单挤出屏幕。 */
const VIEWPORT_MARGIN_PX = 8;

/**
 * 多线路卡片上的线路名：点开给这台节点的这一行换一条线路。
 *
 * 换的先存本机、逐节点逐行记（`pingLineOverrideStore`）；登录站长到设置页点「保存到后端」才会并进
 * 站点配置（`homepagePingLineOverrides`）、对所有访客生效。换线路本身不发任何请求 ——
 * 首页缓冲区里每个样本本来就带着全部线路的值，换的只是「画哪一条」。
 * 菜单本体只在打开时挂载：首页几十张卡 × 几行，平时每行只是一颗按钮，不订阅设置和缓冲区。
 */
export function PingLineSwitcher({
  uuid,
  slot,
  taskName,
}: {
  uuid: string;
  slot: number;
  taskName: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="multi-ping-name multi-ping-name-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`${taskName}，切换这一行的线路`}
        title="切换线路"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <span className="multi-ping-name-text">{taskName}</span>
      </button>
      {open && (
        <PingLineMenu
          id={panelId}
          uuid={uuid}
          slot={slot}
          triggerRef={triggerRef}
          onClose={close}
        />
      )}
    </>
  );
}

function PingLineMenu({
  id,
  uuid,
  slot,
  triggerRef,
  onClose,
}: {
  id: string;
  uuid: string;
  slot: number;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: (restoreFocus: boolean) => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const { homepageMultiPingTaskIds, homepagePingLineOverrides } = useThemeSettings();
  const overrides = useNodePingLineOverrides(uuid);
  const available = useAvailablePingTaskIds(uuid);
  const carrierNames = useCarrierNames();
  // 这台节点的「默认」= 站点线路表 + 站长存到后端的逐节点换线；本机换的行相对它记，「恢复默认」也回到它。
  const nodeDefault = resolveNodePingLineTaskIds(
    homepageMultiPingTaskIds,
    nodePingLineOverrides(homepagePingLineOverrides, uuid),
  );
  const displayed = resolveNodePingLineTaskIds(nodeDefault, overrides);
  const currentTaskId = displayed[slot];
  // 有数据的线路才列（后端对没配探测目标的槽位下发 false，换过去只会是一行「无样本」）；
  // 正在显示的几条哪怕暂时没数据也列上，否则找不到当前选中项，也没法把它换回来。
  const options = CARRIER_TASKS.filter(
    (task) => available.includes(task.id) || displayed.includes(task.id),
  ).map((task) => task.id);
  // 没有生效的本机覆盖时 resolve 原样返回默认那份数组，引用不同就说明本机换过。
  const customized = displayed !== nodeDefault;

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    // 挂在 body 上、fixed 定位：卡片有 overflow:hidden 和 content-visibility:auto，放卡内会被裁掉。
    const anchor = trigger.getBoundingClientRect();
    panel.style.maxHeight = "";
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const roomBelow = window.innerHeight - anchor.bottom - PANEL_GAP_PX - VIEWPORT_MARGIN_PX;
    const roomAbove = anchor.top - PANEL_GAP_PX - VIEWPORT_MARGIN_PX;
    // 下面放得下就往下；放不下、且上面更宽裕才翻上去（线路行在卡片底部，靠近屏幕底边很常见）。
    const above = height > roomBelow && roomAbove > roomBelow;
    const room = Math.max(0, above ? roomAbove : roomBelow);
    const shownHeight = Math.min(height, room);
    const maxLeft = document.documentElement.clientWidth - width - VIEWPORT_MARGIN_PX;
    panel.style.maxHeight = `${room}px`;
    panel.style.top = `${
      above ? anchor.top - PANEL_GAP_PX - shownHeight : anchor.bottom + PANEL_GAP_PX
    }px`;
    panel.style.left = `${Math.max(VIEWPORT_MARGIN_PX, Math.min(anchor.left, maxLeft))}px`;
  }, [customized, options.length, triggerRef]);

  useEffect(() => {
    const panel = panelRef.current;
    const initial =
      panel?.querySelector<HTMLButtonElement>("[data-active='true']") ??
      panel?.querySelector<HTMLButtonElement>("button");
    initial?.focus({ preventScroll: true });

    const isInside = (target: EventTarget | null) =>
      target instanceof Node &&
      (panel?.contains(target) === true || triggerRef.current?.contains(target) === true);
    const onPointerDown = (event: PointerEvent) => {
      if (!isInside(event.target)) onClose(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose(true);
    };
    // 浮层是 fixed 的，页面一滚就和线路名脱开了；与其跟着重算位置，不如直接收起。
    const onScroll = (event: Event) => {
      if (!isInside(event.target)) onClose(false);
    };
    const onResize = () => onClose(false);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [onClose, triggerRef]);

  const select = (taskId: number) => {
    setPingLineOverrides(uuid, switchPingLine(nodeDefault, overrides, slot, taskId));
    onClose(true);
  };

  const reset = () => {
    setPingLineOverrides(uuid, EMPTY_PING_LINE_OVERRIDES);
    onClose(true);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // 浮层挂在 body 末尾，Tab 出去会跳到页面最后；收起并回到线路名，Tab 顺序才接得上卡片。
    if (event.key === "Tab") {
      event.preventDefault();
      onClose(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowUp"
            ? (current <= 0 ? items.length : current) - 1
            : (current + 1) % items.length;
    items[next]?.focus();
  };

  return createPortal(
    <div
      ref={panelRef}
      id={id}
      className="ping-line-menu"
      role="group"
      aria-label="切换线路"
      onKeyDown={handleKeyDown}
    >
      {options.map((taskId) => {
        const active = taskId === currentTaskId;
        // 已经在别的行显示的线路：选它是两行互换，不会画出两行一样的。
        const swaps = !active && displayed.includes(taskId);
        return (
          <button
            key={taskId}
            type="button"
            className="ping-line-menu-item"
            data-active={active ? "true" : "false"}
            aria-current={active ? "true" : undefined}
            onClick={() => select(taskId)}
          >
            <span className="ping-line-menu-label">{carrierTaskName(taskId, carrierNames)}</span>
            {swaps && <span className="ping-line-menu-hint">互换</span>}
            {active && <Check size={14} aria-hidden />}
          </button>
        );
      })}
      {customized && (
        <>
          <div className="ping-line-menu-divider" role="separator" />
          <button
            type="button"
            className="ping-line-menu-item"
            title="这台节点的线路恢复成站点设置"
            onClick={reset}
          >
            <RotateCcw size={13} aria-hidden />
            <span className="ping-line-menu-label">恢复默认</span>
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
