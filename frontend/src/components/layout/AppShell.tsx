import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useTheme } from "next-themes";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Moon, Sun, LogOut } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { isPanelMode } from "@/lib/panelMode";
import { logout, whoami } from "@/lib/fleetApi";

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
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
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
      <LogOut className="h-4 w-4" />
      <span className="flex-1 text-left truncate">{data.username || "Sign out"}</span>
    </button>
  );
}

export function AppShell() {
  const { t } = useTranslation();
  const navItems = [
    { to: "/", label: t("nav.dashboard"), end: true },
    ...(isPanelMode ? [{ to: "/fleet", label: t("nav.fleet", "Fleet") }] : []),
    { to: "/containers", label: t("nav.containers") },
    { to: "/rules", label: t("nav.rules") },
    { to: "/policies", label: t("nav.policies") },
    { to: "/proposals", label: t("nav.proposals") },
    ...(isPanelMode
      ? [
          { to: "/templates", label: t("nav.templates", "Templates") },
          { to: "/approvals", label: t("nav.approvals", "Approvals") },
          { to: "/agent-tokens", label: t("nav.agentTokens", "Agent tokens") },
        ]
      : []),
    { to: "/logs", label: t("nav.logs") },
    { to: "/history", label: t("nav.history") },
  ];
  return (
    <div className="min-h-screen flex">
      <aside className="w-52 shrink-0 border-r bg-muted/40 flex flex-col">
        <div className="px-6 py-5 border-b">
          <span className="text-lg font-bold tracking-tight">Firefik</span>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1" aria-label="Main navigation">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  "block px-3 py-2 rounded-md text-sm font-medium transition-colors",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="px-3 pb-4 space-y-1">
          <LogoutButton />
          <ThemeToggle />
        </div>
      </aside>

      <main className="flex-1 overflow-auto p-8">
        <Outlet />
      </main>
    </div>
  );
}
