import { Fragment, useEffect, useRef } from "react";
import { Link, Navigate, NavLink, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, LinkIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { isPanelMode } from "@/lib/panelMode";
import { cn } from "@/lib/utils";
import { HELP_SECTIONS } from "./registry";

function visibleSections() {
  return HELP_SECTIONS.filter((s) => isPanelMode || !s.panelOnly);
}

function SectionPicker({ current }: { current: string }) {
  const navigate = useNavigate();
  const sections = visibleSections();
  const groups = [...new Set(sections.map((s) => s.group))];
  return (
    <label className="flex flex-col gap-1 text-sm font-medium md:hidden">
      Sections
      <select
        value={current}
        onChange={(e) => navigate(`/help/${e.target.value}`)}
        className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm font-normal dark:bg-input/30"
      >
        {groups.map((group) => (
          <optgroup key={group} label={group}>
            {sections
              .filter((s) => s.group === group)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {sections.indexOf(s) + 1}. {s.title}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function HelpNav() {
  const sections = visibleSections();
  return (
    <nav aria-label="Help sections" className="flex flex-col gap-0.5">
      {sections.map((s, i) => (
        <Fragment key={s.id}>
          {sections[i - 1]?.group !== s.group && (
            <p className="px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {s.group}
            </p>
          )}
          <NavLink
            to={`/help/${s.id}`}
            className={({ isActive }) =>
              cn(
                "grid grid-cols-[1.25rem_minmax(0,1fr)] items-baseline gap-2 rounded-md px-3 py-1.5 text-sm leading-snug transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )
            }
          >
            <span className="font-mono text-xs opacity-70">{i + 1}</span>
            <span className="break-words">{s.title}</span>
          </NavLink>
        </Fragment>
      ))}
    </nav>
  );
}

export default function HelpPage() {
  const { section: sectionId } = useParams<{ section?: string }>();
  const navigate = useNavigate();
  const topRef = useRef<HTMLDivElement>(null);
  const sections = visibleSections();
  const index = sections.findIndex((s) => s.id === sectionId);
  const section = sections[index];
  const previous = sections[index - 1];
  const next = sections[index + 1];

  useEffect(() => {
    topRef.current?.closest("main")?.scrollTo?.({ top: 0 });
  }, [sectionId]);

  if (!sectionId) return <Navigate to={`/help/${sections[0]!.id}`} replace />;
  if (!section) return <Navigate to="/help" replace />;

  const copyLink = () => {
    navigator.clipboard
      .writeText(window.location.href)
      .then(() => toast.success("Link to this section copied"))
      .catch(() => toast.error("Could not copy the link"));
  };

  return (
    <div ref={topRef} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Help</h1>
          <p className="text-sm text-muted-foreground">
            {section.group} · {section.title}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-muted-foreground">
            {index + 1} / {sections.length}
          </span>
          <Button variant="outline" size="sm" onClick={copyLink}>
            <LinkIcon className="mr-1 h-4 w-4" />
            Copy link
          </Button>
        </div>
      </div>

      <SectionPicker current={section.id} />

      <div className="grid gap-6 md:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="hidden md:block">
          <div className="sticky top-4 max-h-[calc(100svh-2rem)] overflow-y-auto rounded-lg border bg-muted/30 p-2">
            <HelpNav />
          </div>
        </aside>

        <article className="min-w-0 max-w-3xl space-y-5">
          <section.Component />

          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <span className="text-sm text-muted-foreground">
              {next ? `Next: ${next.title}` : "That's everything. "}
              {!next && (
                <Link to="/" className="underline">
                  Back to the dashboard
                </Link>
              )}
            </span>
            <div className="flex gap-2">
              {previous && (
                <Button variant="outline" onClick={() => navigate(`/help/${previous.id}`)}>
                  <ArrowLeft className="mr-1 h-4 w-4" />
                  Back
                </Button>
              )}
              {next && (
                <Button onClick={() => navigate(`/help/${next.id}`)}>
                  Next
                  <ArrowRight className="ml-1 h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        </article>
      </div>
    </div>
  );
}
