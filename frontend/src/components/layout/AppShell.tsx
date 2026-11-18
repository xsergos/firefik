import { useRef, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useTheme } from "next-themes";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  BadgeCheck,
  BookOpen,
  Boxes,
  GitPullRequest,
  History,
  KeyRound,
  LayoutDashboard,
  LayoutTemplate,
  ListChecks,
  LogOut,
  Menu,
  Moon,
  Server,
  Shield,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { isPanelMode } from "@/lib/panelMode";
import { logout, whoami } from "@/lib/fleetApi";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  panelOnly?: boolean;
};

type NavGroup = { label: string; items: NavItem[] };

const itemClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors",
    isActive
      ? "bg-primary text-primary-foreground"
      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
  );

function ThemeToggle() {
  const { t } = useTranslation();
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  return (
    <button
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
      aria-label={isDark ? t("theme.switchToLight") : t("theme.switchToDark")}
    >
      {isDark ? <Sun className="h-4 w-4" aria-hidden /> : <Moon className="h-4 w-4" aria-hidden />}
      {isDark ? t("theme.lightMode") : t("theme.darkMode")}
    </button>
  );
}

function LogoutButton() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: 60_000,
    retry: false,
    enabled: isPanelMode,
  });
  if (!data || data.auth_kind !== "session") return null;
  return (
    <button
      onClick={async () => {
        try {
          await logout();
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "logout failed");
          return;
        }
        qc.clear();
        navigate("/login", { replace: true });
      }}
      className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
      aria-label="Sign out"
    >
      <LogOut className="h-4 w-4" aria-hidden />
      <span className="flex-1 text-left truncate">{data.username || "Sign out"}</span>
    </button>
  );
}

function useNavGroups(): NavGroup[] {
  const { t } = useTranslation();
  const groups: NavGroup[] = [
    {
      label: t("nav.groupOverview", "Overview"),
      items: [
        { to: "/", label: t("nav.dashboard"), icon: LayoutDashboard, end: true },
        { to: "/fleet", label: t("nav.fleet", "Fleet"), icon: Server, panelOnly: true },
      ],
    },
    {
      label: t("nav.groupProtect", "Protect"),
      items: [
        { to: "/containers", label: t("nav.containers"), icon: Boxes },
        { to: "/rules", label: t("nav.rules"), icon: ListChecks },
        { to: "/policies", label: t("nav.policies"), icon: Shield },
        {
          to: "/templates",
          label: t("nav.templates", "Templates"),
          icon: LayoutTemplate,
          panelOnly: true,
        },
      ],
    },
    {
      label: t("nav.groupWatch", "Watch"),
      items: [
        { to: "/logs", label: t("nav.logs"), icon: Activity },
        { to: "/history", label: t("nav.history"), icon: History },
      ],
    },
    {
      label: t("nav.groupAdvanced", "Advanced"),
      items: [
        { to: "/proposals", label: t("nav.proposals"), icon: GitPullRequest },
        {
          to: "/approvals",
          label: t("nav.approvals", "Approvals"),
          icon: BadgeCheck,
          panelOnly: true,
        },
        {
          to: "/agent-tokens",
          label: t("nav.agentTokens", "Agent tokens"),
          icon: KeyRound,
          panelOnly: true,
        },
      ],
    },
  ];
  return groups
    .map((g) => ({ ...g, items: g.items.filter((i) => isPanelMode || !i.panelOnly) }))
    .filter((g) => g.items.length > 0);
}

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const groups = useNavGroups();
  return (
    <>
      <nav className="flex-1 overflow-y-auto px-3 py-3" aria-label="Main navigation">
        {groups.map((group) => (
          <div key={group.label} className="pb-2">
            <p className="px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {group.label}
            </p>
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  onClick={onNavigate}
                  className={itemClass}
                >
                  <item.icon className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="min-w-0">{item.label}</span>
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="border-t px-3 py-3 space-y-1">
        <NavLink to="/help" onClick={onNavigate} className={itemClass}>
          <BookOpen className="h-4 w-4 shrink-0" aria-hidden />
          {t("nav.help", "Help")}
        </NavLink>
        <LogoutButton />
        <ThemeToggle />
      </div>
    </>
  );
}

export function AppShell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const closeMenu = () => setMenuOpen(false);

  return (
    <div className="flex h-svh flex-col md:flex-row">
      <a
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          mainRef.current?.focus();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-md"
      >
        Skip to content
      </a>

      <aside className="flex shrink-0 flex-col border-b bg-muted/40 md:h-full md:w-52 md:border-r md:border-b-0">
        <div className="flex items-center justify-between px-4 py-2 md:border-b md:px-6 md:py-5">
          <span className="text-lg font-bold tracking-tight">Firefik</span>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Open menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            <Menu aria-hidden />
          </Button>
        </div>
        <div className="hidden min-h-0 flex-1 flex-col md:flex">
          <SidebarBody />
        </div>
      </aside>

      <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
        <DialogContent
          aria-describedby={undefined}
          className="top-0 left-0 flex h-svh w-64 max-w-[85vw] translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-background p-0 sm:max-w-[85vw] md:hidden"
        >
          <div className="border-b px-6 py-4">
            <DialogTitle className="text-lg font-bold tracking-tight">Menu</DialogTitle>
          </div>
          <SidebarBody onNavigate={closeMenu} />
        </DialogContent>
      </Dialog>

      <main
        id="main"
        ref={mainRef}
        tabIndex={-1}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 outline-none md:p-8"
      >
        <Outlet />
      </main>
    </div>
  );
}
