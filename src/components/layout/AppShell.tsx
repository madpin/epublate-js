/**
 * AppShell — sidebar + header + outlet for every route.
 *
 * UX layout (left to right, top to bottom):
 *
 * - **Brand mark** (top-left). Click takes you home (Projects). The
 *   subtitle disappears when the sidebar is collapsed.
 * - **Library section**. Always visible: Projects, Lore Books. These
 *   are global — they don't change when a project is open.
 * - **Project section**. Only renders once a project is open. Headed
 *   by the project's display name plus a tiny "switch project" link
 *   so the curator never feels stuck inside a single book. Children:
 *   Dashboard, Reader, Glossary, Inbox, Project Settings, plus the
 *   advanced bits (Intake runs, LLM activity, Logs).
 * - **Footer**. Settings, theme picker, and the "everything is local"
 *   reassurance. Mock-mode banner when active.
 *
 * Why two sections?
 *
 * The pre-existing flat list (Projects → Intake → Inbox → Glossary →
 * Reader → LLM → Logs → Settings) interleaved global and per-project
 * routes, so once a project was open the curator had to mentally
 * filter "is this 'Settings' the global one or this project's?". The
 * sectioned layout matches the mental model: top group is "what
 * library am I looking at?", middle group is "what part of *this*
 * project am I working on?", and the global Settings retreats to the
 * footer where it belongs.
 *
 * The component itself is dumb: no Dexie reads beyond the project
 * name (which would otherwise force the user to re-read the URL to
 * remember which book they're in). Project name is loaded via
 * `useLiveQuery` from the library projection, so a rename anywhere
 * in the app is reflected immediately.
 */

import * as React from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowLeft,
  BookOpen,
  Database,
  FlaskConical,
  Home,
  Library,
  ListChecks,
  Logs,
  Network,
  Settings as SettingsIcon,
  Sparkles,
  SquareLibrary,
} from "lucide-react";

import { BatchStatusBar } from "./BatchStatusBar";
import { CheatSheet } from "./CheatSheet";
import { ThemeToggle } from "./ThemeToggle";
import { libraryDb } from "@/db/library";
import { useAppStore } from "@/state/app";
import { useLastProjectStore } from "@/state/last_project";
import { cn } from "@/lib/utils";
import { Toaster } from "@/components/ui/sonner";

interface NavItem {
  /** Path suffix (no leading `/project/:id` — that gets prepended for project items). */
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** "end" prop on `NavLink` — true for routes that are exact-match. */
  end?: boolean;
}

const LIBRARY: NavItem[] = [
  { to: "/", label: "Projects", icon: Library, end: true },
  { to: "/lore", label: "Lore Books", icon: SquareLibrary },
];

const PROJECT_PRIMARY: NavItem[] = [
  { to: "", label: "Dashboard", icon: Home, end: true },
  { to: "/reader", label: "Reader", icon: BookOpen },
  { to: "/glossary", label: "Glossary", icon: Network },
  { to: "/inbox", label: "Inbox", icon: ListChecks },
];

const PROJECT_SECONDARY: NavItem[] = [
  { to: "/intake", label: "Intake runs", icon: FlaskConical },
  { to: "/llm", label: "LLM activity", icon: Sparkles },
  { to: "/logs", label: "Logs", icon: Logs },
  { to: "/settings", label: "Project settings", icon: SettingsIcon },
];

export function AppShell(): React.JSX.Element {
  const location = useLocation();
  const project_match = location.pathname.match(/^\/project\/([^/]+)/);
  const url_project_id = project_match ? project_match[1] : null;
  const mock_mode = useAppStore((s) => s.mock_mode);
  const last_project_id = useLastProjectStore((s) => s.last_project_id);
  const remember_last = useLastProjectStore((s) => s.remember);
  const forget_last = useLastProjectStore((s) => s.forget);

  // Track the URL's active project so global routes (Settings, Lore
  // Books, Projects list) can still keep the project's nav section
  // visible. We "remember" the URL id every time it changes; if the
  // URL has no project we fall back to the remembered id.
  React.useEffect(() => {
    if (url_project_id) remember_last(url_project_id);
  }, [url_project_id, remember_last]);

  const sidebar_project_id = url_project_id ?? last_project_id;

  // Look up the project's display name from the library projection so
  // the sidebar header reflects the current book without a separate
  // store. `useLiveQuery` re-fires after rename, so the header stays
  // honest even mid-session.
  const project = useLiveQuery(
    async () =>
      sidebar_project_id ? libraryDb().projects.get(sidebar_project_id) : null,
    [sidebar_project_id],
    null,
  );

  // If the remembered project has been deleted (live query returns
  // `undefined`), drop it so the sidebar collapses cleanly. We only
  // do this for the *fallback* path — when the URL points at the
  // project, deletion is the user's own action and the route will
  // navigate away regardless.
  React.useEffect(() => {
    if (
      sidebar_project_id &&
      sidebar_project_id !== url_project_id &&
      project === undefined
    ) {
      forget_last(sidebar_project_id);
    }
  }, [sidebar_project_id, url_project_id, project, forget_last]);

  const project_open = sidebar_project_id !== null && project !== undefined;
  const project_id = sidebar_project_id;

  return (
    <div className="flex h-full w-full bg-background text-foreground">
      <aside className="flex w-60 shrink-0 flex-col border-r bg-card/40">
        <Link
          to="/"
          className="flex items-center gap-2 border-b px-4 py-4 transition-colors hover:bg-accent/40"
        >
          <div className="flex size-8 items-center justify-center rounded-md bg-primary/15 text-primary">
            <BookOpen className="size-4" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold tracking-tight">
              epublate
            </span>
            <span className="text-[11px] text-muted-foreground">
              browser port
            </span>
          </div>
        </Link>

        <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3 pt-3">
          <NavSection label="Library">
            {LIBRARY.map((item) => (
              <SidebarLink key={item.to} item={item} to={item.to} />
            ))}
          </NavSection>

          {project_open ? (
            <NavSection
              label="Project"
              project_name={project?.name ?? "(unnamed)"}
              project_id={project_id!}
            >
              {PROJECT_PRIMARY.map((item) => (
                <SidebarLink
                  key={item.to}
                  item={item}
                  to={`/project/${project_id}${item.to}`}
                />
              ))}
              <Separator />
              {PROJECT_SECONDARY.map((item) => (
                <SidebarLink
                  key={item.to}
                  item={item}
                  to={`/project/${project_id}${item.to}`}
                />
              ))}
            </NavSection>
          ) : null}
        </nav>

        <div className="border-t px-2 py-3">
          <SidebarLink
            item={{
              to: "/settings",
              label: "Settings",
              icon: SettingsIcon,
            }}
            to="/settings"
          />
          <div className="mt-3 flex items-center justify-between px-2 text-xs text-muted-foreground">
            <span>Theme</span>
            <ThemeToggle />
          </div>
          <div className="mt-3 px-2 text-[11px] leading-snug text-muted-foreground">
            All data lives in your browser. Nothing is uploaded.
          </div>
          {mock_mode ? (
            <div className="mt-2 rounded-md bg-warning/15 px-2 py-1 text-[11px] font-semibold text-warning">
              Mock LLM mode — no network calls.
            </div>
          ) : null}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <BatchStatusBar />
        <Outlet />
      </main>
      <CheatSheet />
      <Toaster />
    </div>
  );
}

function NavSection({
  label,
  project_name,
  project_id,
  children,
}: {
  label: string;
  /** Render a project-name header instead of the plain label. */
  project_name?: string;
  project_id?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="mt-1 first:mt-0">
      {project_name ? (
        <div className="mb-1 flex items-baseline justify-between gap-2 px-2 pt-2">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <Database className="size-3 shrink-0 text-primary" />
            <span
              className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
              title={project_name}
            >
              {project_name}
            </span>
          </div>
          {project_id ? (
            <Link
              to="/"
              className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
              title="Back to projects list"
            >
              <ArrowLeft className="size-2.5" />
              switch
            </Link>
          ) : null}
        </div>
      ) : (
        <div className="mb-1 px-2 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
      )}
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function SidebarLink({
  item,
  to,
}: {
  item: NavItem;
  to: string;
}): React.JSX.Element {
  return (
    <NavLink
      to={to}
      end={item.end ?? false}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors",
          isActive
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        )
      }
    >
      <item.icon className="size-4" />
      <span className="truncate">{item.label}</span>
    </NavLink>
  );
}

function Separator(): React.JSX.Element {
  return <div className="my-1 h-px bg-border" aria-hidden="true" />;
}
