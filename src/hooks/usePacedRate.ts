import { useEffect, useRef, useState } from "react";

/**
 * 把「实时带宽」这类**跨节点聚合值**按固定节拍更新。
 *
 * 各节点按自己的上报节奏刷新、相位互不相同，聚合值于是可能一秒内变好几次，读数还没看清就跳了。
 * 这里攒住最新值、按固定节拍统一换一次：单台卡片仍按各自节奏走（那是它自己的真实数据），
 * 顶部这个求和则稳定在每秒一跳。
 *
 * 首个节拍到来前直接透传实时值，避免首屏白等一拍显示 0。
 */
export function usePacedRate(
  up: number,
  down: number,
  intervalMs = 1_000,
): { up: number; down: number } {
  const latest = useRef({ up, down });
  latest.current = { up, down };
  const [paced, setPaced] = useState({ up, down });

  useEffect(() => {
    const timer = window.setInterval(() => {
      setPaced((previous) =>
        previous.up === latest.current.up && previous.down === latest.current.down
          ? previous
          : { ...latest.current },
      );
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);

  // 还没换过一拍（仍是挂载时那份 0）就先用实时值。
  return paced.up === 0 && paced.down === 0 ? { up, down } : paced;
}
