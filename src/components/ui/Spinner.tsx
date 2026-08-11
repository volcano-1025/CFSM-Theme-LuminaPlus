export function Spinner({
  size = 20,
  label = "加载中",
}: {
  size?: number;
  label?: string;
}) {
  return (
    <span
      role={label ? "status" : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      className="inline-block animate-spin rounded-full border-2 border-[var(--border-subtle)] border-t-[var(--accent-500)] motion-reduce:animate-none"
      style={{ width: size, height: size }}
    />
  );
}
