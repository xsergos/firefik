import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Figure({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <figure className="space-y-2">
      <div
        className="rounded-xl border bg-muted/30 p-4 overflow-x-auto"
        role="img"
        aria-label={caption}
      >
        {children}
      </div>
      <figcaption className="text-xs text-muted-foreground">{caption}</figcaption>
    </figure>
  );
}

export function MockWindow({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border bg-background shadow-sm min-w-[18rem]">
      <div className="flex items-center gap-1.5 border-b px-3 py-2">
        <span className="h-2 w-2 rounded-full bg-red-400/70" />
        <span className="h-2 w-2 rounded-full bg-amber-400/70" />
        <span className="h-2 w-2 rounded-full bg-green-400/70" />
        <span className="ml-2 text-xs font-medium text-muted-foreground">{title}</span>
      </div>
      <div className="p-3 text-xs space-y-2">{children}</div>
    </div>
  );
}

export function Pill({
  tone = "muted",
  children,
}: {
  tone?: "ok" | "warn" | "bad" | "muted" | "primary";
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold",
        tone === "ok" && "bg-green-600 text-white",
        tone === "warn" && "bg-amber-400 text-black",
        tone === "bad" && "bg-red-600 text-white",
        tone === "muted" && "bg-muted text-muted-foreground",
        tone === "primary" && "bg-primary text-primary-foreground",
      )}
    >
      {children}
    </span>
  );
}

export function MockRow({ cells, highlight }: { cells: ReactNode[]; highlight?: boolean }) {
  return (
    <div
      className={cn(
        "grid gap-3 rounded px-2 py-1.5 items-center",
        highlight && "ring-2 ring-primary/60 bg-primary/5",
      )}
      style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }}
    >
      {cells.map((c, i) => (
        <div key={i} className="truncate">
          {c}
        </div>
      ))}
    </div>
  );
}

export function Callout({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warn";
  title: string;
  children: ReactNode;
}) {
  return (
    <aside
      className={cn(
        "rounded-lg border-l-4 p-3 text-sm space-y-1",
        tone === "info" && "border-primary bg-primary/5",
        tone === "warn" && "border-amber-500 bg-amber-500/10",
      )}
    >
      <p className="font-medium">{title}</p>
      <div className="text-muted-foreground">{children}</div>
    </aside>
  );
}

export function Steps({ items }: { items: { title: string; text: ReactNode }[] }) {
  return (
    <ol className="space-y-3">
      {items.map((s, i) => (
        <li key={s.title} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-primary/12 font-mono text-xs text-primary">
            {i + 1}
          </span>
          <div className="text-sm">
            <p className="font-medium">{s.title}</p>
            <div className="text-muted-foreground">{s.text}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function Code({ children }: { children: string }) {
  return (
    <pre className="rounded-lg border bg-muted/50 p-3 text-xs font-mono overflow-x-auto whitespace-pre">
      {children}
    </pre>
  );
}

export function ArchitectureDiagram() {
  const box = "rounded-lg border bg-background px-3 py-2 text-center text-xs shadow-sm";
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr_auto_1fr] items-center min-w-[32rem]">
      <div className="space-y-2">
        {["host-01", "host-02", "host-03"].map((h) => (
          <div key={h} className={box}>
            <div className="font-mono font-semibold">{h}</div>
            <div className="text-muted-foreground">agent + containers</div>
          </div>
        ))}
      </div>
      <div className="text-center text-muted-foreground text-xs">
        reports state,
        <br />
        traffic, changes
        <div className="text-lg">→</div>
        <div className="text-lg">←</div>
        commands
      </div>
      <div className={cn(box, "py-6")}>
        <div className="font-semibold">Control plane</div>
        <div className="text-muted-foreground">remembers everything</div>
      </div>
      <div className="text-lg text-muted-foreground text-center">⇄</div>
      <div className={cn(box, "py-6 ring-2 ring-primary/50")}>
        <div className="font-semibold">This panel</div>
        <div className="text-muted-foreground">you are here</div>
      </div>
    </div>
  );
}

export function RuleOrderDiagram() {
  const rows: [string, ReactNode, string][] = [
    ["1", "Source is on the blocklist", "DROP"],
    ["2", "Source is on the allowlist", "ACCEPT"],
    ["3", "Anyone else to a listed port", "DROP"],
    ["4", "Ports you did not list", "default policy"],
  ];
  return (
    <div className="space-y-1.5 min-w-[22rem]">
      {rows.map(([n, text, verdict]) => (
        <div
          key={n}
          className="flex items-center gap-3 rounded-md border bg-background px-3 py-2 text-xs"
        >
          <span className="font-mono text-muted-foreground">{n}</span>
          <span className="flex-1">{text}</span>
          <Pill tone={verdict === "ACCEPT" ? "ok" : verdict === "DROP" ? "bad" : "muted"}>
            {verdict}
          </Pill>
        </div>
      ))}
    </div>
  );
}
