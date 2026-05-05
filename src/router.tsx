import { createBrowserRouter, Navigate } from "react-router-dom";

import { AppShell } from "@/components/layout/AppShell";
import { ProjectsRoute } from "@/routes/ProjectsRoute";
import { DashboardRoute } from "@/routes/DashboardRoute";
import { GlossaryRoute } from "@/routes/GlossaryRoute";
import { InboxRoute } from "@/routes/InboxRoute";
import { IntakeRunsRoute } from "@/routes/IntakeRunsRoute";
import { LlmActivityRoute } from "@/routes/LlmActivityRoute";
import { LogsRoute } from "@/routes/LogsRoute";
import { LoreBookDashboardRoute } from "@/routes/LoreBookDashboardRoute";
import { LoreBooksRoute } from "@/routes/LoreBooksRoute";
import { ProjectSettingsRoute } from "@/routes/ProjectSettingsRoute";
import { ReaderRoute } from "@/routes/ReaderRoute";
import { SettingsRoute } from "@/routes/SettingsRoute";
import { StubRoute } from "@/routes/StubRoute";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <ProjectsRoute /> },
      { path: "settings", element: <SettingsRoute /> },
      { path: "lore", element: <LoreBooksRoute /> },
      { path: "lore/:loreId", element: <LoreBookDashboardRoute /> },
      {
        path: "intake",
        element: (
          <StubRoute
            title="Intake runs"
            description="Open a project from the dashboard to view its intake history."
            phase="P5"
          />
        ),
      },
      {
        path: "project/:projectId/intake",
        element: <IntakeRunsRoute />,
      },
      {
        path: "inbox",
        element: (
          <StubRoute
            title="Inbox"
            description="Open a project from the dashboard to view its inbox."
            phase="P4"
          />
        ),
      },
      {
        path: "project/:projectId/inbox",
        element: <InboxRoute />,
      },
      {
        path: "glossary",
        element: (
          <StubRoute
            title="Glossary"
            description="Open a project from the dashboard to view its glossary."
            phase="P3"
          />
        ),
      },
      {
        path: "project/:projectId/glossary",
        element: <GlossaryRoute />,
      },
      {
        path: "reader",
        element: (
          <StubRoute
            title="Reader"
            description="Open a project from the dashboard to enter the Reader."
            phase="P2"
          />
        ),
      },
      {
        path: "project/:projectId/reader",
        element: <ReaderRoute />,
      },
      {
        path: "llm",
        element: (
          <StubRoute
            title="LLM activity"
            description="Open a project from the dashboard to view its LLM audit log."
            phase="P6"
          />
        ),
      },
      {
        path: "project/:projectId/llm",
        element: <LlmActivityRoute />,
      },
      {
        path: "logs",
        element: (
          <StubRoute
            title="Logs"
            description="Open a project from the dashboard to view its event log."
            phase="P6"
          />
        ),
      },
      {
        path: "project/:projectId/logs",
        element: <LogsRoute />,
      },
      {
        path: "project/:projectId/settings",
        element: <ProjectSettingsRoute />,
      },
      {
        path: "project/:projectId",
        element: <DashboardRoute />,
      },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);
