import { useEffect, useRef, useState } from "react";

/**
 * 把「实时带宽」这类**跨节点聚合值**按固定节奏整体更新。
 *
 * 每台节点各自约 2 秒上报一次且彼此错开，store 于是每约 1 秒提交一次、每次只带其中几台。
 * 聚合值若跟着每次提交重算，就是「部分新 + 部分旧」拼出来的和，看上去毫无规律地乱跳
 * （单台卡片没这个问题，它只看自己那一份）。这里改成攒住最新值、按固定节拍一起换，
 * 于是总量匀速前进；节拍取节点自身的上报周期量级，读数不会因此变旧。
 *
 * 首个节拍到来前直接透传实时值，避免首屏白等一拍显示 0。
 */
export function usePacedRate(
  up: number,
  down: number,
  intervalMs = 2_000,
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
