"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Globe,
  HardDrive,
  LayoutGrid,
  Loader2,
  LogOut,
  Moon,
  ScrollText,
  Settings,
  Plus,
  Server,
  Sun,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { BRAND, cn, inkOn } from "@/lib/utils";
import { Button } from "@/components/ui";

interface Me {
  user: {
    uid: string;
    username: string;
    displayName: string;
    role: string;
    avatarColor: string;
  };
  /** False until an owner has answered the first-run networking question. */
  setupCompleted: boolean;
}

/**
 * The application shell.
 *
 * Sidebar on desktop, bottom bar on mobile. Auth is enforced here rather than
 * in each page, so an expired session bounces to login once instead of
 * rendering a page full of failed requests.
 *
 * The header carries a filesystem-style path rather than a plain title. It is
 * the same information, but it also answers "where am I and how do I get
 * back", which a bare heading does not.
 */

/** Human label plus the mono path shown in the header. */
function describeRoute(pathname: string): { label: string; path: string } {
  if (pathname.startsWith("/account"))
    return { label: "Account", path: "~/account" };
  if (pathname.startsWith("/people"))
    return { label: "People", path: "~/people" };
  if (pathname.startsWith("/machines"))
    return { label: "Machines", path: "~/machines" };
  if (pathname.startsWith("/audit"))
    return { label: "Audit log", path: "~/audit" };
  if (pathname === "/servers/new")
    return { label: "Deploy server", path: "~/servers/new" };
  if (pathname.startsWith("/servers/")) {
    const uid = pathname.split("/")[2] ?? "";
    return { label: "Server overview", path: `~/servers/${uid.slice(0, 8)}` };
  }
  return { label: "Control center", path: "~/servers" };
}
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const stored =
      (localStorage.getItem("sf-theme") as "dark" | "light" | null) ?? "dark";
    setTheme(stored);
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("sf-theme", next);
    document.documentElement.classList.remove("dark", "light");
    document.documentElement.classList.add(next);
    document.documentElement.style.colorScheme = next;
  };

  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<Me>("/api/auth/me"),
    retry: false,
  });

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401)
      router.replace("/login");
  }, [me.error, router]);

  // First run: send the owner through setup before the dashboard, so the panel
  // is never handing out a join address nobody has been asked about. /setup is
  // outside this layout, so there is no redirect loop.
  useEffect(() => {
    if (me.data && !me.data.setupCompleted) router.replace("/setup");
  }, [me.data, router]);

  if (me.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center gap-2.5">
        <Loader2 className="h-4 w-4 animate-spin text-accent" />
        <span className="text-[13px] text-ink-subtle">connecting…</span>
        <span className="sr-only">Loading your servers</span>
      </div>
    );
  }

  if (!me.data) {
    // A 401 is handled above. Anything else — usually a wrong API URL or a
    // stopped panel — used to render a blank page, which looks like a crash.
    const message =
      me.error instanceof ApiError
        ? me.error.body.message
        : "The dashboard loaded, but it could not reach the API.";
    return (
      <div className="flex h-screen items-center justify-center px-6">
        <div className="max-w-md space-y-3 text-center">
          <p className="eyebrow text-danger">connection refused</p>
          <h1 className="display text-lg">Can&apos;t reach the panel</h1>
          <p className="text-[13px] leading-relaxed text-ink-muted">{message}</p>
          <Button variant="secondary" onClick={() => me.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  // Only routes that exist are listed — a nav entry that 404s is worse than
  // one that is absent.
  //
  // The panel section is owner/admin only, matching the API: showing it to a
  // subuser would offer pages that answer 403.
  const canManagePanel =
    me.data.user.role === "owner" || me.data.user.role === "admin";

  const nav = [
    { href: "/servers", label: "Servers", icon: LayoutGrid },
    ...(canManagePanel
      ? [
          { href: "/people", label: "People", icon: Users },
          { href: "/machines", label: "Machines", icon: HardDrive, mobile: false },
          { href: "/network", label: "Network", icon: Globe },
          { href: "/audit", label: "Audit log", icon: ScrollText, mobile: false },
        ]
      : []),
    { href: "/account", label: "Account", icon: Settings },
  ];

  // The bottom bar splits the width evenly between its entries, so past four
  // the labels stop fitting on a phone. Capacity planning and log reading are
  // desk work; they stay reachable by URL and from the sidebar on a tablet up.
  const mobileNav = nav.filter((item) => item.mobile !== false);
  const route = describeRoute(pathname);

  const signOut = async () => {
    await api.post("/api/auth/logout").catch(() => undefined);
    router.push("/login");
  };

  // The shell is a fixed viewport: the sidebar and header never move, and
  // only <main> scrolls. That is what keeps the dashboard on one screen
  // instead of the whole window scrolling under a sticky header.
  return (
    <div className="flex h-screen overflow-hidden bg-canvas" data-sf-shell>
      {/* ── Sidebar (desktop) ────────────────────────────────────────── */}
      <aside
        className="relative hidden w-60 shrink-0 flex-col border-r border-line bg-surface md:flex"
        data-sf-sidebar
      >
        <div className="flex h-14 items-center gap-2.5 border-b border-line px-4">
          <div className="inset-well flex h-7 w-7 items-center justify-center text-accent">
            <Server className="h-3.5 w-3.5" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="engraved truncate text-[13px]">{BRAND.name}</p>
            <p className="legend mt-1 truncate">Server control</p>
          </div>
        </div>

        <div className="px-3 pt-3.5">
          <Button
            variant="primary"
            className="w-full justify-start"
            onClick={() => router.push("/servers/new")}
          >
            <Plus className="h-4 w-4" aria-hidden />
            Deploy a server
          </Button>
        </div>

        <nav
          className="flex-1 space-y-0.5 overflow-y-auto px-3 py-3 pt-5 scrollbar-thin"
          aria-label="Main"
          data-sf-nav
        >
          <p className="legend mb-2.5 px-2.5">Workspace</p>
          {nav.map((item) => {
            const active =
              pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  // The selected row is the only filled surface in the nav;
                  // everything else is plain text until it is hovered.
                  "group relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors",
                  active
                    ? "bg-surface-raised font-medium text-ink"
                    : "text-ink-muted hover:bg-surface-raised/60 hover:text-ink",
                )}
              >
                <item.icon
                  className={cn(
                    "h-4 w-4 shrink-0",
                    active ? "text-accent" : "text-ink-subtle",
                  )}
                  aria-hidden
                />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-line px-3 py-3">
          <div className="mb-2 flex items-center gap-2.5 px-0.5 py-1">
            <div
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
              style={{
                backgroundColor: me.data.user.avatarColor,
                color: inkOn(me.data.user.avatarColor),
              }}
              aria-hidden
            >
              {me.data.user.displayName.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium">
                {me.data.user.displayName}
              </p>
              <p className="legend mt-1 truncate">{me.data.user.role}</p>
            </div>
          </div>

          <div className="flex gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="flex-1"
              onClick={toggleTheme}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            >
              {theme === "dark" ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="flex-1"
              onClick={signOut}
              aria-label="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </aside>

      {/* ── Main column ──────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col" data-sf-workspace>
        <header
          className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line bg-canvas/70 px-4 backdrop-blur-xl md:px-6"
          data-sf-topbar
        >
          <div className="flex items-center gap-2.5 md:hidden">
            <div className="inset-well flex h-8 w-8 items-center justify-center text-accent">
              <Server className="h-4 w-4" aria-hidden />
            </div>
            <div>
              <span className="block text-[13px] font-semibold">
                {BRAND.name}
              </span>
              <span className="block font-mono text-[10px] text-ink-subtle">
                {route.path}
              </span>
            </div>
          </div>

          {/* Where you are: the human label, then the same thing as a path,
              which is what answers "how do I get back". */}
          <div className="hidden min-w-0 items-center gap-2.5 md:flex">
            <p className="engraved shrink-0 text-[13px]">{route.label}</p>
            <p className="truncate font-mono text-[11.5px] text-ink-subtle">
              {route.path}
            </p>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={toggleTheme}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            >
              {theme === "dark" ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={signOut}
              aria-label="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </Button>
            {pathname !== "/servers/new" && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => router.push("/servers/new")}
              >
                <Plus className="h-4 w-4" aria-hidden />
                <span className="hidden sm:inline">New server</span>
              </Button>
            )}
          </div>
        </header>

        {/* Only this region scrolls; the header above and sidebar stay put. */}
        <main
          id="main"
          data-sf-main
          className="min-h-0 flex-1 overflow-y-auto px-4 pb-24 pt-5 scrollbar-thin sm:px-6 md:px-8 md:pb-8 md:pt-6"
        >
          {children}
        </main>
      </div>

      {/* ── Bottom nav (mobile) ──────────────────────────────────────── */}
      <nav
        className="fixed bottom-0 left-0 right-0 z-30 flex border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden"
        aria-label="Main"
        data-sf-mobile-nav
      >
        {mobileNav.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex flex-1 flex-col items-center gap-1 py-3 text-[11px]",
                active ? "font-medium text-accent" : "text-ink-muted",
              )}
            >
              {active && (
                <span className="absolute inset-x-1/3 top-0 h-0.5 rounded-full bg-accent" />
              )}
              <item.icon className="h-[18px] w-[18px]" aria-hidden />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
