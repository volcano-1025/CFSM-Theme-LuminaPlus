import type { ReactNode } from "react";
import { clsx } from "clsx";
import { Spinner } from "@/components/ui/Spinner";

export function InstancePanel({
  title,
  kicker,
  titleAction,
  description,
  aside,
  children,
  className,
}: {
  title: string;
  kicker?: ReactNode;
  titleAction?: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx("instance-panel", kicker != null && "has-kicker", className)}>
      <header className="instance-panel-header">
        <div className="instance-panel-headings">
          {kicker != null && <span className="instance-panel-kicker">{kicker}</span>}
          <div className="instance-panel-title-row">
            <h2 className="instance-panel-title">{title}</h2>
            {titleAction}
          </div>
          {description != null && <p className="instance-panel-description">{description}</p>}
        </div>
        {aside != null && <div className="instance-panel-aside">{aside}</div>}
      </header>
      {children}
    </section>
  );
}

export function InstanceChartLoading({ title }: { title: string }) {
  return (
    <InstancePanel title={title}>
      <div className="instance-chart-loading" aria-busy>
        <Spinner size={26} label="" />
        <span>加载中…</span>
      </div>
    </InstancePanel>
  );
}
