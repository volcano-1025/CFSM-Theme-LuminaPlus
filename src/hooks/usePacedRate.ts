import { useEffect, useRef, useState } from "react";

/**
 * 决定这次变化是立刻显示还是排到下一拍：返回还要等多少毫秒，0 表示现在就换。
 *
 * 口径是**两次换值之间至少隔 intervalMs**，而不是"每 intervalMs 换一次"。
 * 差别在首屏：页面刚打开时各节点的第一帧是先后到的，第一个到的值应当立刻显示
 * （等满一拍会让顶部干挂一秒的 0），之后的变化再按最小间隔压住。
 *
 * `lastShownAt` 为 0 表示还没显示过任何值 —— 直接放行。
 */
export function resolvePacedEmitDelay(
  lastShownAt: number,
  now: number,
  intervalMs: number,
): number {
  if (lastShownAt <= 0) return 0;
  const elapsed = now - lastShownAt;
  if (!Number.isFinite(elapsed) || elapsed >= intervalMs) return 0;
  // elapsed 可能是负的（系统时钟被往回拨），此时也只等一拍，不能把显示卡更久。
  return Math.min(intervalMs, intervalMs - elapsed);
}

/**
 * 把「实时带宽」这类**跨节点聚合值**压到最快每 intervalMs 才变一次。
 *
 * 各节点按自己的上报节奏刷新、相位互不相同，聚合值于是可能一秒内变好几次，读数还没看清就跳了。
 * 首屏更明显：各节点的第一帧先后到达（实测 8 台铺开在 1~2 秒里），求和会一路往上垒。
 * 这里不拦这个垒的过程 —— 有几台的数据就显示几台的和，是照实的 —— 只保证**相邻两次换值
 * 至少隔一秒**：期间来的新值攒在 ref 里，到点一次性显示最新的那份。
 * 单台卡片仍按各自节奏走（那是它自己的真实数据），只有顶部这个求和走节拍。
 *
 * 早先的写法是 `setInterval` + 「paced 还是 0 就透传实时值」，在首屏整段爬升期间
 * paced 恰好一直是 0，于是每次渲染都直接透传 —— 1 秒节拍在最需要它的时候等于没生效
 * （站长反馈的「一秒内跳好几次」）。而且聚合值真的是 0（全部节点空闲）时会永久透传。
 */
export function usePacedRate(
  up: number,
  down: number,
  intervalMs = 1_000,
): { up: number; down: number } {
  const latest = useRef({ up, down });
  latest.current = { up, down };
  const [paced, setPaced] = useState({ up, down });
  // 当前显示的那份。与 paced 同步，但可以在 effect 里同步读到，不受渲染时机影响。
  const shown = useRef(paced);
  const lastShownAt = useRef(0);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const show = () => {
      timer.current = null;
      const next = latest.current;
      if (shown.current.up === next.up && shown.current.down === next.down) return;
      shown.current = next;
      lastShownAt.current = Date.now();
      setPaced(next);
    };

    // 已经排了一拍就不重排：那一拍到点时取的是届时最新的值，中间的变化本来就该被吞掉。
    if (timer.current != null) return;
    const delay = resolvePacedEmitDelay(lastShownAt.current, Date.now(), intervalMs);
    if (delay <= 0) show();
    else timer.current = window.setTimeout(show, delay);
  }, [up, down, intervalMs]);

  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );

  return paced;
}
