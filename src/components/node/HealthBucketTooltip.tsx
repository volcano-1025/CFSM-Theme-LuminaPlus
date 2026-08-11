import type { CSSProperties } from "react";

export function HealthBucketTooltip({
  text,
  index,
  count,
}: {
  text: string | null;
  index: number | null;
  count: number;
}) {
  if (!text || index == null || count <= 0) return null;

  const position = ((index + 0.5) / count) * 100;
  const style = {
    "--node-health-tooltip-x": `clamp(42px, ${position}%, calc(100% - 42px))`,
  } as CSSProperties;

  return (
    <span className="node-health-hover-tooltip" style={style} role="status">
      {text}
    </span>
  );
}
