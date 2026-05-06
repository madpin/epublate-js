/**
 * Help & Guides route — the in-app onboarding / tutorials surface.
 *
 * What lives here
 * ---------------
 *
 * A single, tour-style page that takes a fresh curator from "I just
 * opened the app" to "I'm shipping a translated ePub", with the
 * connectivity story for **local Ollama on a deployed HTTPS origin**
 * called out front-and-centre because that's the rough edge most
 * users hit first.
 *
 * Sections (anchored by stable `id` so deep links don't rot):
 *
 * 1. Quickstart                — five-step starter card grid.
 * 2. `local-llm`               — Ollama install + the multi-scheme
 *                                `OLLAMA_ORIGINS` recipe + LNA
 *                                troubleshooting for HTTPS deploys.
 * 3. `cloud-llm`               — provider table (OpenAI, OpenRouter,
 *                                Together, Groq, DeepInfra) with
 *                                what to paste in Settings.
 * 4. `workflow`                — visual walkthrough of the seven
 *                                primary screens, each with a
 *                                screenshot.
 * 5. `prompts`                 — the configurable-prompts /
 *                                summary / simulator surface.
 * 6. `privacy`                 — what crosses the wire, what stays
 *                                in this browser.
 * 7. `keyboard`                — the cheat-sheet snapshot + a hint
 *                                that `?` / F1 surface the live
 *                                version everywhere.
 * 8. `troubleshooting`         — collapsible answers for common
 *                                connectivity / cache / glossary
 *                                snags.
 * 9. `further-reading`         — pointers at the README,
 *                                ARCHITECTURE, USAGE on GitHub.
 *
 * Why an in-app page (vs. a markdown file)
 * ----------------------------------------
 *
 * The repo's `docs/USAGE.md` already exists as the long-form curator
 * tour, but the deployed SPA can't reach the GitHub-hosted version
 * offline, and curators on the Vercel build hit the *exact* LNA
 * issue this page documents — sending them off-site to a markdown
 * file isn't a great answer to "why doesn't my Ollama work?". So we
 * mirror the most-needed slices of `docs/USAGE.md` in the app, and
 * the markdown file remains the source-of-truth for the longer
 * narrative + repo contributors.
 *
 * Screenshot strategy
 * -------------------
 *
 * `docs/screenshots/` is the single source of truth (re-captured by
 * `tools/snap.mjs` in `?mock=1` mode). We pull the curated subset we
 * actually want to display through Vite's `import.meta.glob({ ...,
 * query: "?url" })`, so the help screen ships hashed, fingerprinted
 * URLs in the build output without duplicating PNGs into a second
 * folder. If a future capture renames a file, the page surfaces a
 * "missing screenshot" placeholder rather than crashing the route.
 */

import * as React from "react";
import {
  ArrowRight,
  BookOpen,
  Boxes,
  CheckCircle2,
  ChevronRight,
  Cloud,
  Copy,
  ExternalLink,
  FileText,
  Keyboard,
  LifeBuoy,
  Lightbulb,
  ListChecks,
  Lock,
  Network,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal,
  TriangleAlert,
  Wand2,
  Workflow,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/state/ui";

/* -------------------------------------------------------------------------- */
/*  Screenshots — pulled from docs/screenshots via Vite asset glob.            */
/* -------------------------------------------------------------------------- */

/**
 * Curated subset of the canonical screenshot set, keyed by the
 * filename stem the doc contract uses (see `docs/screenshots/README.md`).
 *
 * `import.meta.glob({ eager: true, query: "?url" })` is the Vite-blessed
 * way to bundle PNGs from outside `src/` into the build output without
 * an explicit per-file import. Vite hashes the URLs (good for the
 * service-worker precache) and tree-shakes anything we don't reference.
 *
 * Path note: `/docs/screenshots/*.png` is *project-root-absolute* in
 * Vite's glob syntax, not filesystem-absolute, so it picks up the
 * canonical capture set even though `docs/` lives outside `src/`.
 */
const SHOT_URLS = import.meta.glob("/docs/screenshots/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

function shot(name: string): string | null {
  const key = `/docs/screenshots/${name}`;
  return SHOT_URLS[key] ?? null;
}

/* -------------------------------------------------------------------------- */
/*  Section / table-of-contents wiring.                                       */
/* -------------------------------------------------------------------------- */

interface TocEntry {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const TOC: readonly TocEntry[] = [
  { id: "quickstart", label: "Quickstart", icon: Zap },
  { id: "local-llm", label: "Local Ollama", icon: Server },
  { id: "cloud-llm", label: "Cloud LLMs", icon: Cloud },
  { id: "workflow", label: "Workflow tour", icon: Workflow },
  { id: "prompts", label: "Prompts & summaries", icon: Wand2 },
  { id: "privacy", label: "Privacy", icon: ShieldCheck },
  { id: "keyboard", label: "Keyboard shortcuts", icon: Keyboard },
  { id: "troubleshooting", label: "Troubleshooting", icon: LifeBuoy },
  { id: "further-reading", label: "Further reading", icon: FileText },
];

/* -------------------------------------------------------------------------- */
/*  Route component.                                                          */
/* -------------------------------------------------------------------------- */

export function HelpRoute(): React.JSX.Element {
  const setActiveScreen = useUiStore((s) => s.setActiveScreen);
  React.useEffect(() => setActiveScreen("help"), [setActiveScreen]);

  // Deep-link (`/help#local-llm`, `/help#troubleshooting`, …) needs
  // an explicit nudge: React Router will not auto-scroll on hash
  // change because the component already mounted. We listen for hash
  // changes and scroll the matching section into view, accounting for
  // the sticky ToC bar via `scroll-mt-*` on each <section>.
  const { hash } = useLocationHash();
  React.useEffect(() => {
    if (!hash) return;
    const target = document.getElementById(hash.slice(1));
    if (target) target.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [hash]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b px-6 py-4">
        <div className="flex items-center gap-2">
          <LifeBuoy className="size-5 text-primary" />
          <h1 className="text-xl font-semibold tracking-tight">
            Help &amp; guides
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Onboarding, the local-LLM connectivity recipe, and a tour of every
          screen — without leaving the app.
        </p>
      </header>

      <div className="flex-1 overflow-y-auto">
        <Hero />
        <TocBar />

        <div className="mx-auto w-full max-w-5xl px-6 py-10">
          <Quickstart />
          <LocalLlm />
          <CloudLlm />
          <WorkflowTour />
          <PromptsSection />
          <PrivacySection />
          <KeyboardSection />
          <TroubleshootingSection />
          <FurtherReading />

          <div className="mt-12 border-t pt-6 text-center text-xs text-muted-foreground">
            Need more depth? The{" "}
            <ExternalDocLink href="https://github.com/madpin/epublate-js/blob/main/docs/USAGE.md">
              full USAGE.md
            </ExternalDocLink>
            ,{" "}
            <ExternalDocLink href="https://github.com/madpin/epublate-js/blob/main/docs/ARCHITECTURE.md">
              ARCHITECTURE.md
            </ExternalDocLink>
            , and{" "}
            <ExternalDocLink href="https://github.com/madpin/epublate-js">
              repo README
            </ExternalDocLink>{" "}
            on GitHub go deeper than this page.
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Hero strip.                                                               */
/* -------------------------------------------------------------------------- */

function Hero(): React.JSX.Element {
  return (
    <div className="border-b bg-gradient-to-br from-primary/10 via-background to-accent/20 px-6 py-10">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 lg:flex-row lg:items-center">
        <div className="flex-1 space-y-4">
          <Badge variant="secondary" className="w-fit text-[11px]">
            New here? Start at Quickstart, then jump straight to{" "}
            <a
              href="#local-llm"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Local Ollama
            </a>
            .
          </Badge>
          <h2 className="text-3xl font-semibold tracking-tight">
            Translate ePubs in your browser, on your terms.
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            <strong className="text-foreground">epublate</strong> is a
            local-first translation studio. Your books, glossary, API keys, and
            LLM prompts never leave this device — except for the one HTTPS call
            you configure to your own OpenAI-compatible endpoint. This page is
            your map.
          </p>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <FactPill icon={Lock} label="Local-first by design" />
            <FactPill icon={BookOpen} label="Byte-equivalent ePub round-trip" />
            <FactPill icon={Boxes} label="OpenAI-compatible LLMs only" />
            <FactPill icon={Sparkles} label="Resumable batches" />
          </div>
          <div className="flex flex-wrap gap-2 pt-2">
            <Button asChild size="sm">
              <a href="#quickstart">
                <Zap className="mr-1.5 size-3.5" />
                Quickstart
              </a>
            </Button>
            <Button asChild size="sm" variant="outline">
              <a href="#local-llm">
                <Server className="mr-1.5 size-3.5" />
                Connect local Ollama
              </a>
            </Button>
            <Button asChild size="sm" variant="outline">
              <a href="#troubleshooting">
                <LifeBuoy className="mr-1.5 size-3.5" />
                Troubleshooting
              </a>
            </Button>
          </div>
        </div>
        <HeroShot />
      </div>
    </div>
  );
}

function HeroShot(): React.JSX.Element {
  const src = shot("00-hero.png");
  if (!src) {
    return (
      <div className="hidden h-48 w-72 rounded-lg border bg-card/40 lg:block" />
    );
  }
  return (
    <figure className="relative hidden overflow-hidden rounded-lg border bg-card/40 shadow-md lg:block lg:w-96">
      <img
        src={src}
        alt="Project dashboard with a fully translated book and a chapter list."
        className="block h-auto w-full"
        loading="eager"
        decoding="async"
      />
    </figure>
  );
}

function FactPill({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border bg-card/60 px-2.5 py-1 text-foreground/80 backdrop-blur">
      <Icon className="size-3.5 text-primary" />
      {label}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  Sticky table of contents.                                                 */
/* -------------------------------------------------------------------------- */

function TocBar(): React.JSX.Element {
  return (
    <div className="sticky top-0 z-10 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/65">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-1.5 px-6 py-2 text-xs">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          On this page
        </span>
        {TOC.map((entry) => (
          <a
            key={entry.id}
            href={`#${entry.id}`}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
          >
            <entry.icon className="size-3" />
            {entry.label}
          </a>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Section helpers.                                                          */
/* -------------------------------------------------------------------------- */

function Section({
  id,
  icon: Icon,
  title,
  summary,
  children,
}: {
  id: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  summary?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      id={id}
      // The sticky ToC is ~38px tall; nudge anchored sections so
      // the heading isn't hidden behind it on jump.
      className="scroll-mt-20 pt-10 first:pt-2"
      aria-labelledby={`${id}-title`}
    >
      <div className="mb-4 flex items-baseline gap-2">
        <Icon className="size-4 shrink-0 translate-y-0.5 text-primary" />
        <h2
          id={`${id}-title`}
          className="text-2xl font-semibold tracking-tight"
        >
          {title}
        </h2>
      </div>
      {summary ? (
        <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
          {summary}
        </p>
      ) : null}
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Note({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warning" | "success";
  title?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const toneClasses =
    tone === "warning"
      ? "border-warning/40 bg-warning/10 text-warning"
      : tone === "success"
        ? "border-success/40 bg-success/10 text-success"
        : "border-primary/40 bg-primary/10 text-primary";
  const Icon =
    tone === "warning"
      ? TriangleAlert
      : tone === "success"
        ? CheckCircle2
        : Lightbulb;
  return (
    <div
      className={cn(
        "flex gap-3 rounded-md border px-3 py-2 text-sm",
        toneClasses,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="space-y-1">
        {title ? <div className="font-semibold">{title}</div> : null}
        <div className="text-foreground/90">{children}</div>
      </div>
    </div>
  );
}

function CodeBlock({
  language = "bash",
  children,
  copyValue,
}: {
  language?: "bash" | "text";
  children: string;
  /** Override the value placed on the clipboard (defaults to `children`). */
  copyValue?: string;
}): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);
  const onCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(copyValue ?? children);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      toast.error("Couldn't copy — your browser blocked clipboard access.");
    }
  }, [copyValue, children]);

  return (
    <div className="group relative overflow-hidden rounded-md border bg-card/60">
      <div className="flex items-center justify-between border-b bg-muted/30 px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>{language === "bash" ? "shell" : "text"}</span>
        <button
          type="button"
          onClick={() => void onCopy()}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Copy to clipboard"
        >
          {copied ? (
            <>
              <CheckCircle2 className="size-3 text-success" />
              copied
            </>
          ) : (
            <>
              <Copy className="size-3" />
              copy
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto whitespace-pre px-4 py-3 font-mono text-[12.5px] leading-relaxed text-foreground">
        <code>{children}</code>
      </pre>
    </div>
  );
}

function Screenshot({
  name,
  alt,
  caption,
  className,
}: {
  /** Filename stem in `docs/screenshots/`, e.g. `12-settings-llm.png`. */
  name: string;
  alt: string;
  caption?: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  const src = shot(name);
  if (!src) {
    // Don't crash the whole page if a screenshot is missing — most
    // common cause is a future filename rename. Surface the absence
    // visibly so the doc-set rule's reviewer notices.
    return (
      <div
        className={cn(
          "rounded-md border border-dashed bg-muted/20 px-4 py-6 text-center text-xs text-muted-foreground",
          className,
        )}
      >
        Screenshot <code>{name}</code> is missing — re-run{" "}
        <code>node tools/snap.mjs</code>.
      </div>
    );
  }
  return (
    <figure
      className={cn(
        "overflow-hidden rounded-md border bg-card/40 shadow-sm",
        className,
      )}
    >
      <img
        src={src}
        alt={alt}
        className="block h-auto w-full"
        loading="lazy"
        decoding="async"
      />
      {caption ? (
        <figcaption className="border-t bg-card/40 px-3 py-2 text-xs text-muted-foreground">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

/* -------------------------------------------------------------------------- */
/*  Section: Quickstart.                                                      */
/* -------------------------------------------------------------------------- */

interface QuickStep {
  n: number;
  title: string;
  body: React.ReactNode;
  shot?: string;
  shotAlt?: string;
}

const QUICK_STEPS: QuickStep[] = [
  {
    n: 1,
    title: "Connect your LLM",
    body: (
      <>
        Open <strong>Settings → LLM endpoint</strong>, paste a base URL and (for
        cloud providers) an API key, save, and tap <em>Test connection</em>.
        Local Ollama and OpenAI-compatible clouds work the same way.
      </>
    ),
    shot: "12-settings-llm.png",
    shotAlt: "Settings → LLM endpoint card with base URL + API key fields",
  },
  {
    n: 2,
    title: "Create a project",
    body: (
      <>
        From <strong>Projects</strong> drop an ePub onto the dropzone or click{" "}
        <em>New project</em>. Pick the source / target languages and a literary
        preset; auto-intake will summarise the book and seed a glossary while
        you settle in.
      </>
    ),
    shot: "02-new-project-modal.png",
    shotAlt: "New project modal with petitprince.epub loaded",
  },
  {
    n: 3,
    title: "Tune your style",
    body: (
      <>
        On the project Dashboard open <strong>Project settings</strong> and walk
        through Identity, Style, Context window, Prompt options, and
        (optionally) Book / Chapter summaries — they're what gives the LLM the
        same instinct a human translator brings.
      </>
    ),
    shot: "09-project-settings.png",
    shotAlt: "Project Settings with all the cards visible",
  },
  {
    n: 4,
    title: "Translate the book",
    body: (
      <>
        Press <kbd className="rounded border bg-muted px-1 font-mono">B</kbd> on
        the Dashboard, scope <em>Whole project</em>, and run. The batch is
        resumable — close the tab, come back tomorrow, everything picks up where
        it stopped.
      </>
    ),
    shot: "05c-batch-modal-dashboard.png",
    shotAlt: "Batch modal opened from the Dashboard",
  },
  {
    n: 5,
    title: "Review &amp; export",
    body: (
      <>
        Spend time in <strong>Reader</strong>: the source pane stays in sync
        with the target, and locked terms / suggestions surface inline. When the
        inbox empties, click <em>Export ePub</em> and you'll get a
        byte-equivalent translated book back.
      </>
    ),
    shot: "04-reader.png",
    shotAlt: "Reader view of Chapitre III, prose-rich",
  },
];

function Quickstart(): React.JSX.Element {
  return (
    <Section
      id="quickstart"
      icon={Zap}
      title="Quickstart"
      summary={
        <>
          Five steps from "fresh tab" to "downloading the translated ePub". The
          ordering matters: do step 1 first or steps 2–5 have nothing to talk
          to.
        </>
      }
    >
      <div className="grid gap-4 lg:grid-cols-2">
        {QUICK_STEPS.map((step) => (
          <Card key={step.n} className="overflow-hidden">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
                  {step.n}
                </div>
                <CardTitle className="text-base">{step.title}</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 pt-0">
              <div className="text-sm text-foreground/85">{step.body}</div>
              {step.shot ? (
                <Screenshot
                  name={step.shot}
                  alt={step.shotAlt ?? ""}
                  className="border-muted/40"
                />
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Section: Local Ollama (the headline of this page).                        */
/* -------------------------------------------------------------------------- */

const OLLAMA_ORIGINS_VALUE =
  "http://*,https://*,chrome-extension://*,moz-extension://*";

const OLLAMA_RUN_RECIPE = `> export OLLAMA_ORIGINS="${OLLAMA_ORIGINS_VALUE}"
> ollama serve`;

const OLLAMA_LAUNCHCTL_RECIPE = `# macOS, when Ollama runs as a launchd service
> launchctl setenv OLLAMA_ORIGINS "${OLLAMA_ORIGINS_VALUE}"
> launchctl unload  ~/Library/LaunchAgents/com.ollama.plist
> launchctl load    ~/Library/LaunchAgents/com.ollama.plist`;

const OLLAMA_VERIFY = `> curl -i http://localhost:11434/v1/models
> curl -H 'Origin: https://your-deploy.example' \\
       -i http://localhost:11434/v1/models`;

const OLLAMA_TUNNEL_RECIPES = `# Pick one:
> tailscale serve --https=11434 http://127.0.0.1:11434
> cloudflared tunnel --url http://localhost:11434
> ngrok http 11434`;

function LocalLlm(): React.JSX.Element {
  return (
    <Section
      id="local-llm"
      icon={Server}
      title="Connect a local LLM (Ollama)"
      summary={
        <>
          Local Ollama is the recommended day-to-day setup: $0 per token, zero
          cloud telemetry, and surprisingly fast warm calls (Ollama caches the
          system prompt prefix). Two of the three steps here are pure Ollama
          config — epublate just needs a base URL.
        </>
      }
    >
      {/* Step 1 — install + pull a model */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Terminal className="size-4 text-primary" />
            1. Install Ollama and pull a model
          </CardTitle>
          <CardDescription>
            Any chat-capable model works; an instruct-tuned one in the 7-30B
            range is a good starting point.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-foreground/85">
            Grab the installer from{" "}
            <ExternalDocLink href="https://ollama.com/download">
              ollama.com/download
            </ExternalDocLink>{" "}
            (macOS / Linux / Windows). Once it's running, pull a model:
          </p>
          <CodeBlock>{`> ollama pull llama3.1:8b      # safe default
> ollama pull qwen2.5:14b      # stronger, still fits 16GB RAM
> ollama pull gemma2:27b       # the heaviest option we test against`}</CodeBlock>
          <Note tone="info" title="Picking a model">
            Bigger isn't always better — translation quality is dominated by
            your <strong>glossary</strong>, <strong>style guide</strong>, and{" "}
            <strong>book summary</strong>. Start small, get the round trip
            working end-to-end, and only scale up the model once you have
            something to compare against.
          </Note>
        </CardContent>
      </Card>

      {/* Step 2 — the spotlight: OLLAMA_ORIGINS. */}
      <Card className="border-primary/40 bg-primary/[0.04]">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4 text-primary" />
            2. Restart Ollama with the multi-scheme allow-list
          </CardTitle>
          <CardDescription>
            This is the single most important setting on this page. The bare{" "}
            <code>OLLAMA_ORIGINS=*</code> shorthand is parsed differently across
            Ollama versions and frequently rejects <code>https://</code>{" "}
            origins, which is why deployed (Vercel / Netlify / Cloudflare Pages)
            builds silently fail their pre-flight CORS check.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-foreground/85">
            Use the explicit four-scheme value below. It allow-lists HTTP and
            HTTPS pages plus the two browser-extension schemes Chrome / Firefox
            use:
          </p>
          <CodeBlock copyValue={OLLAMA_RUN_RECIPE}>
            {OLLAMA_RUN_RECIPE}
          </CodeBlock>
          <p className="text-sm text-foreground/85">
            On macOS, when Ollama is running as a launchd service (the "Ollama
            is running" menu-bar app), set the variable at the launchd level
            instead so it survives reboots:
          </p>
          <CodeBlock copyValue={OLLAMA_LAUNCHCTL_RECIPE}>
            {OLLAMA_LAUNCHCTL_RECIPE}
          </CodeBlock>
          <Note
            tone="warning"
            title="Verify CORS before troubleshooting anything else"
          >
            <>
              The response to the second curl below <strong>must</strong>{" "}
              include an <code>Access-Control-Allow-Origin</code> header that
              matches your page's origin. If it doesn't, Ollama is ignoring your
              env var — re-check it landed in the process actually serving the
              API.
            </>
          </Note>
          <CodeBlock>{OLLAMA_VERIFY}</CodeBlock>
        </CardContent>
      </Card>

      {/* Step 3 — paste the URL into Settings. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wand2 className="size-4 text-primary" />
            3. Paste the URL into Settings
          </CardTitle>
          <CardDescription>
            epublate is OpenAI-compatible and Ollama already exposes an
            OpenAI-compatible endpoint at <code>/v1</code>, so the integration
            is "paste the URL, hit save".
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-foreground/85">
            <li>
              Go to <strong>Settings → LLM endpoint</strong>.
            </li>
            <li>
              Set <strong>Base URL</strong> to{" "}
              <code>http://localhost:11434/v1</code>.
            </li>
            <li>Leave the API key blank (Ollama ignores it).</li>
            <li>
              Set <strong>Translator model</strong> to whatever you pulled —
              e.g. <code>llama3.1:8b</code>.
            </li>
            <li>
              Click <strong>Save</strong>, then <strong>Test connection</strong>
              .
            </li>
          </ol>
          <Screenshot
            name="12-settings-llm.png"
            alt="Settings → LLM endpoint card with the Test connection button visible"
            caption="Settings → LLM endpoint. The card description repeats the OLLAMA_ORIGINS recipe so you don't have to come back here for it."
          />
        </CardContent>
      </Card>

      {/* Step 4 — the deployed-on-Vercel scenario. */}
      <Card className="border-warning/30 bg-warning/[0.04]">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Network className="size-4 text-warning" />
            4. Special case: HTTPS deploy ↔ <code>http://localhost</code>
          </CardTitle>
          <CardDescription>
            Trying to use the Vercel build (<code>https://…</code>) with your
            local Ollama (<code>http://localhost</code>)? You crossed two
            browser security layers — mixed-content and Local Network Access —
            and need to satisfy both.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-foreground/85">
            Chrome 142+ replaced the older Private Network Access policy with{" "}
            <strong>Local Network Access (LNA)</strong>. epublate already
            annotates the fetch with{" "}
            <code>{`targetAddressSpace: "loopback"`}</code>, so Chrome knows to{" "}
            <em>ask</em> you for permission — but two additional things must go
            right:
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-foreground/85">
            <li>
              <strong>Browser side:</strong> click <em>Allow</em> when Chrome
              prompts you for "Local Network Access" the first time. If the
              prompt never appears, open <code>chrome://settings/content</code>{" "}
              → Local Network Access and grant your deploy origin manually, or,
              as a last resort, disable the policy from{" "}
              <code>chrome://flags</code> (search "Local Network Access").
            </li>
            <li>
              <strong>Ollama side:</strong> the env var from step 2 must already
              include <code>https://*</code> — the bare{" "}
              <code>OLLAMA_ORIGINS=*</code> shorthand often rejects
              <code>https://</code> origins.
            </li>
          </ul>
          <Note tone="info" title="The most reliable path">
            <>
              If you'd rather not babysit two browser policies, run the SPA from{" "}
              <code>http://localhost</code> instead: <code>npm run dev</code> or{" "}
              <code>npm run preview</code> keeps both ends on the loopback
              address space and needs no LNA permission at all.
            </>
          </Note>
          <p className="text-sm text-foreground/85">
            Otherwise, put Ollama behind an HTTPS reverse proxy and point the
            SPA at the HTTPS URL. Three known-good options:
          </p>
          <CodeBlock copyValue={OLLAMA_TUNNEL_RECIPES}>
            {OLLAMA_TUNNEL_RECIPES}
          </CodeBlock>
          <p className="text-xs text-muted-foreground">
            The{" "}
            <code>--disable-features=BlockInsecurePrivateNetworkRequests</code>{" "}
            Chrome flag people share online targeted the deprecated PNA system,
            not LNA, so it's a no-op on Chrome 142+.
          </p>
        </CardContent>
      </Card>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Section: Cloud LLMs.                                                      */
/* -------------------------------------------------------------------------- */

interface CloudProvider {
  name: string;
  base_url: string;
  notes: React.ReactNode;
  links?: { label: string; href: string }[];
}

const CLOUD_PROVIDERS: CloudProvider[] = [
  {
    name: "OpenAI",
    base_url: "https://api.openai.com/v1",
    notes: (
      <>
        Reference implementation. Pricing is regularly updated in Settings →
        Pricing; cost meters render in real-time once you've translated a few
        segments.
      </>
    ),
    links: [
      { label: "Get an API key", href: "https://platform.openai.com/api-keys" },
    ],
  },
  {
    name: "OpenRouter",
    base_url: "https://openrouter.ai/api/v1",
    notes: (
      <>
        Single key for many model families. Useful when you want to compare
        frontier models without juggling provider accounts.
      </>
    ),
    links: [{ label: "Get an API key", href: "https://openrouter.ai/keys" }],
  },
  {
    name: "Together AI",
    base_url: "https://api.together.xyz/v1",
    notes: <>Competitive open-weights pricing, fast inference.</>,
    links: [
      {
        label: "Get an API key",
        href: "https://api.together.xyz/settings/api-keys",
      },
    ],
  },
  {
    name: "Groq",
    base_url: "https://api.groq.com/openai/v1",
    notes: (
      <>
        Wild-fast inference on small / mid-size open models — useful for batch
        translation when you don't need the absolute top quality.
      </>
    ),
    links: [{ label: "Get an API key", href: "https://console.groq.com/keys" }],
  },
  {
    name: "DeepInfra",
    base_url: "https://api.deepinfra.com/v1/openai",
    notes: <>Inexpensive open-weights inference at scale.</>,
    links: [
      { label: "Get an API key", href: "https://deepinfra.com/dash/api_keys" },
    ],
  },
];

function CloudLlm(): React.JSX.Element {
  return (
    <Section
      id="cloud-llm"
      icon={Cloud}
      title="Connect a cloud LLM"
      summary={
        <>
          Anything that speaks the OpenAI Chat Completions protocol works. Paste
          the base URL into Settings, paste the key, save. The five listed below
          are the providers we test against most often.
        </>
      }
    >
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-semibold">Provider</th>
                <th className="px-4 py-2 font-semibold">Base URL</th>
                <th className="px-4 py-2 font-semibold">Notes</th>
              </tr>
            </thead>
            <tbody>
              {CLOUD_PROVIDERS.map((p) => (
                <tr key={p.name} className="border-b last:border-b-0">
                  <td className="px-4 py-3 align-top font-semibold">
                    {p.name}
                    {p.links?.map((link) => (
                      <a
                        key={link.href}
                        href={link.href}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 flex items-center gap-1 text-[11px] font-normal text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="size-3" />
                        {link.label}
                      </a>
                    ))}
                  </td>
                  <td className="px-4 py-3 align-top">
                    <code className="rounded bg-muted/40 px-1.5 py-0.5 text-[12px]">
                      {p.base_url}
                    </code>
                  </td>
                  <td className="px-4 py-3 align-top text-foreground/85">
                    {p.notes}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Note tone="info" title="Set a budget before you batch">
        <>
          Settings → <em>Default budget</em> caps spend per project. The status
          bar turns red the moment a batch crosses the limit, and the run pauses
          cleanly so you can decide whether to top up or stop.
        </>
      </Note>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Section: Workflow tour.                                                   */
/* -------------------------------------------------------------------------- */

interface TourStop {
  shot: string;
  title: string;
  blurb: React.ReactNode;
  alt: string;
}

const TOUR_STOPS: TourStop[] = [
  {
    shot: "01b-projects-populated.png",
    alt: "Projects list with one seeded project",
    title: "Projects",
    blurb: (
      <>
        Top-level library. Each card is a self-contained Dexie database — open
        one and the whole sidebar reshapes around its chapters, glossary, and
        audit log.
      </>
    ),
  },
  {
    shot: "03-dashboard-translated.png",
    alt: "Project dashboard with batch progress and chapter list",
    title: "Project dashboard",
    blurb: (
      <>
        Per-book home. Progress bars, lifetime cost, the chapter list, and the
        big red "Translate batch" button live here. The book summary status row
        prompts you to generate one if you haven't.
      </>
    ),
  },
  {
    shot: "04-reader.png",
    alt: "Reader screen with source / target panes",
    title: "Reader",
    blurb: (
      <>
        Three columns: chapter list, source segments, translated segments.
        Locked glossary terms light up inline; flagged segments queue for
        review. Press{" "}
        <kbd className="rounded border bg-muted px-1 font-mono">Shift+P</kbd>{" "}
        for the prompt-preview slide-over.
      </>
    ),
  },
  {
    shot: "05d-reader-prompt-preview.png",
    alt: "Reader Prompt Preview panel",
    title: "Prompt preview",
    blurb: (
      <>
        Dry-run any segment without hitting the LLM. See the exact system
        message, user message, and outgoing wire payload — the same
        XML/glossary/context bundle the batch will send.
      </>
    ),
  },
  {
    shot: "06-glossary.png",
    alt: "Glossary screen with proposed and confirmed entries",
    title: "Glossary",
    blurb: (
      <>
        The book's translation memory. Locked terms are hard-fail; target-only
        entries are soft-locked. Aliases match on word boundaries; particle
        suffixes round-trip (<code>Saito-san</code> ↔ <code>Saito-さん</code>).
      </>
    ),
  },
  {
    shot: "08-inbox.png",
    alt: "Inbox screen with flagged segments and proposed entries",
    title: "Inbox",
    blurb: (
      <>
        Curator's worklist. Flagged segments, proposed entries, and
        budget-paused batches funnel here so nothing goes silent.
      </>
    ),
  },
  {
    shot: "14-llm-activity.png",
    alt: "LLM activity audit log",
    title: "LLM activity",
    blurb: (
      <>
        Every prompt, completion, retry, embedding call, and dollar amount gets
        logged here. Filterable, exportable, and proof the local-first invariant
        is holding.
      </>
    ),
  },
];

function WorkflowTour(): React.JSX.Element {
  return (
    <Section
      id="workflow"
      icon={Workflow}
      title="A typical workflow"
      summary={
        <>
          The seven screens you'll bounce between every session, ordered roughly
          by time-since-import. Click any screenshot to open it full-size in a
          new tab.
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        {TOUR_STOPS.map((stop) => {
          const src = shot(stop.shot);
          return (
            <Card key={stop.shot} className="overflow-hidden">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <ChevronRight className="size-4 text-primary" />
                  {stop.title}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 pt-0 text-sm text-foreground/85">
                <p>{stop.blurb}</p>
                {src ? (
                  <a
                    href={src}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${stop.title} screenshot full size`}
                  >
                    <Screenshot name={stop.shot} alt={stop.alt} />
                  </a>
                ) : (
                  <Screenshot name={stop.shot} alt={stop.alt} />
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Section: Prompts & summaries (the new feature surface).                   */
/* -------------------------------------------------------------------------- */

function PromptsSection(): React.JSX.Element {
  return (
    <Section
      id="prompts"
      icon={Wand2}
      title="Configurable prompts &amp; summaries"
      summary={
        <>
          Translation quality lives or dies by what surrounds the source text.
          Project Settings exposes every block we send to the LLM — toggle them
          on / off and see the impact on tokens, cost, and (most importantly)
          translation consistency.
        </>
      }
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Prompt options</CardTitle>
            <CardDescription>
              The six checkboxes that control which structured XML blocks the
              system / user message carry. Glossary, context window, summaries,
              hints — pick the surface you want.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Screenshot
              name="09c-prompt-options.png"
              alt="Project Settings → Prompt options card"
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Book summary</CardTitle>
            <CardDescription>
              A short, dense paragraph that gives the LLM the same instinct a
              human translator gets from reading the book first. Generate it
              once; reuse it for every chapter.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Screenshot
              name="09d-book-summary.png"
              alt="Project Settings → Book summary card"
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Chapter summaries</CardTitle>
            <CardDescription>
              Per-chapter notes the translator can scope to specific chapters.
              Generate missing ones in bulk, or one-by-one from the Reader's
              chapter menu.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Screenshot
              name="09e-chapter-summaries.png"
              alt="Project Settings → Chapter summaries card"
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Prompt simulator</CardTitle>
            <CardDescription>
              Dry-runs the exact prompt for the project's first non-empty
              segment. Toggle individual options live and watch the token / cost
              meter respond. No LLM call.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Screenshot
              name="09f-prompt-simulator.png"
              alt="Project Settings → Prompt simulator card"
            />
          </CardContent>
        </Card>
      </div>
      <Note tone="success" title="Caching benefit (free, no config)">
        <>
          Static project-stable content (rules, style guide, summary, glossary)
          lives in the <code>system</code> message; per-segment dynamic content
          (chapter notes, retrieved context, source text) lives in{" "}
          <code>user</code>. OpenAI / Ollama prefix caching kicks in
          automatically — observed <strong>~10× faster</strong> warm calls in
          the smoke test suite.
        </>
      </Note>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Section: Privacy.                                                         */
/* -------------------------------------------------------------------------- */

function PrivacySection(): React.JSX.Element {
  return (
    <Section
      id="privacy"
      icon={ShieldCheck}
      title="Privacy &amp; offline guarantees"
      summary={
        <>
          The local-first promise isn't marketing — it's enforced by a repo rule
          (<code>no-network-side-effects.mdc</code>) and reviewed on every PR.
          Here's what that means for your data.
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Lock className="size-4 text-success" />
              Stays on this device
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-foreground/85">
            <ul className="list-disc space-y-1 pl-5">
              <li>The full ePub source.</li>
              <li>Every translated segment, plus its history.</li>
              <li>Glossary, lore books, style guide, summaries.</li>
              <li>Your API keys (IndexedDB on this origin).</li>
              <li>The LLM audit log of every call ever made.</li>
              <li>Cached translations (re-runs hit them, not the API).</li>
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Network className="size-4 text-primary" />
              Goes over the wire
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-foreground/85">
            <ul className="list-disc space-y-1 pl-5">
              <li>Chat-completion calls to the URL you typed in Settings.</li>
              <li>
                Embedding calls to the URL you typed under Embeddings (defaults
                to the same base URL).
              </li>
              <li>
                <em>One-time, after explicit consent:</em> ONNX runtime +{" "}
                <code>Xenova/*</code> weights from <code>cdn.jsdelivr.net</code>{" "}
                / <code>huggingface.co</code> when you opt in to local
                embeddings.
              </li>
              <li>Service-worker assets at install time. That's it.</li>
            </ul>
          </CardContent>
        </Card>
      </div>
      <Note tone="info" title="What's not on this page">
        <>
          No analytics SDK. No telemetry pixel. No autoupdate channel. No crash
          reporter. No third-party fonts loaded at runtime. Every dependency is
          bundled at build time so a single review of the network panel is
          enough to verify the claim.
        </>
      </Note>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Section: Keyboard.                                                        */
/* -------------------------------------------------------------------------- */

function KeyboardSection(): React.JSX.Element {
  return (
    <Section
      id="keyboard"
      icon={Keyboard}
      title="Keyboard shortcuts"
      summary={
        <>
          The full live cheat sheet is one keystroke away —{" "}
          <kbd className="rounded border bg-muted px-1 font-mono text-xs">
            ?
          </kbd>{" "}
          or{" "}
          <kbd className="rounded border bg-muted px-1 font-mono text-xs">
            F1
          </kbd>{" "}
          opens it from any screen. The snapshot below is the same dialog,
          captured deterministically.
        </>
      }
    >
      <Screenshot
        name="15-cheat-sheet.png"
        alt="Cheat-sheet dialog showing global, reader, glossary, and batch shortcut groups"
        caption="The cheat sheet renders the registered hotkeys for the active screen plus the global ones. Reader hotkeys include j/k for nav, t to translate, Shift+P to toggle the prompt preview."
      />
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Section: Troubleshooting.                                                 */
/* -------------------------------------------------------------------------- */

interface TroubleshootEntry {
  q: string;
  a: React.ReactNode;
}

const TROUBLESHOOT: TroubleshootEntry[] = [
  {
    q: "“Connection failed: Failed to fetch” when I click Test connection",
    a: (
      <div className="space-y-2">
        <p>Walk through these in order:</p>
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            Confirm Ollama (or your cloud endpoint) is reachable from your
            terminal: <code>curl -i &lt;BASE_URL&gt;/models</code>. If that
            fails, the SPA isn't the problem.
          </li>
          <li>
            For local Ollama, check that <code>OLLAMA_ORIGINS</code> uses the
            multi-scheme value (see{" "}
            <a className="underline" href="#local-llm">
              section 2
            </a>
            ), not the bare <code>*</code>.
          </li>
          <li>
            For HTTPS deploys → <code>http://localhost</code>: Local Network
            Access has to be granted in Chrome. Re-read the{" "}
            <a className="underline" href="#local-llm">
              "Special case" panel
            </a>{" "}
            above.
          </li>
        </ol>
      </div>
    ),
  },
  {
    q: "Cache hits are 0% even though I'm re-running the same chapter",
    a: (
      <p>
        The cache key includes the model, system message, user message, glossary
        state, and prompt options. Any change there — even a toggled checkbox in{" "}
        <em>Prompt options</em> — invalidates the prefix. The Reader's prompt
        preview (<kbd>Shift+P</kbd>) shows the cache key for the focused segment
        so you can spot the diff.
      </p>
    ),
  },
  {
    q: "My batch crashed mid-run — did I lose the work?",
    a: (
      <p>
        No. Every translated segment is durable in Dexie before the run
        advances. Reload the project, open <em>Inbox</em> if anything went
        flagged, and re-run the batch — it picks up at the first non-translated
        segment.
      </p>
    ),
  },
  {
    q: "“llama runner process no longer running” from Ollama",
    a: (
      <p>
        Some Ollama models (notably the larger Gemma family) crash their
        underlying llama.cpp runner when{" "}
        <code>response_format: json_object</code> is requested. epublate detects
        this 5xx pattern and silently retries without{" "}
        <code>response_format</code> — but if it keeps recurring, your runner is
        OOM-killing. Pull a smaller model or lower <code>num_ctx</code> in
        Settings → Ollama options.
      </p>
    ),
  },
  {
    q: "I exported a translated ePub and the validator complains",
    a: (
      <p>
        That's <em>good</em> — the round-trip validator is guaranteeing your
        output is byte-equivalent in structure to the input. If it fails, the
        failing chapter shows in <em>Inbox</em> with the offending segment
        highlighted; usually the LLM dropped or duplicated a placeholder like{" "}
        <code>[[T0]]</code>. Re-translate that segment and export again.
      </p>
    ),
  },
];

function TroubleshootingSection(): React.JSX.Element {
  return (
    <Section
      id="troubleshooting"
      icon={LifeBuoy}
      title="Troubleshooting"
      summary={
        <>
          Things that have stumped past curators. Tap to expand any item. Ollama
          / LNA setup gets the deepest treatment in{" "}
          <a className="underline" href="#local-llm">
            section 2
          </a>
          .
        </>
      }
    >
      <Card>
        <CardContent className="p-2">
          {TROUBLESHOOT.map((entry, idx) => (
            <details
              key={entry.q}
              className={cn(
                "group rounded-md px-3 py-2",
                idx > 0 && "border-t",
              )}
            >
              <summary className="flex cursor-pointer items-start gap-2 text-sm font-medium text-foreground/90">
                <ListChecks className="mt-0.5 size-4 shrink-0 text-primary transition-transform group-open:rotate-90" />
                <span>{entry.q}</span>
              </summary>
              <div className="mt-2 pl-6 text-sm text-foreground/85">
                {entry.a}
              </div>
            </details>
          ))}
        </CardContent>
      </Card>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Section: Further reading.                                                 */
/* -------------------------------------------------------------------------- */

function FurtherReading(): React.JSX.Element {
  return (
    <Section
      id="further-reading"
      icon={FileText}
      title="Further reading"
      summary={
        <>
          The repo's documentation set goes deeper on architecture, design
          rules, and recipes. All three live on GitHub and mirror the prose on
          this page.
        </>
      }
    >
      <div className="grid gap-3 md:grid-cols-3">
        <DocLink
          href="https://github.com/madpin/epublate-js/blob/main/README.md"
          title="README.md"
          desc="First-contact pitch, install instructions, and the project tagline."
        />
        <DocLink
          href="https://github.com/madpin/epublate-js/blob/main/docs/USAGE.md"
          title="docs/USAGE.md"
          desc="Long-form curator tour. Every screen, every troubleshooting recipe."
        />
        <DocLink
          href="https://github.com/madpin/epublate-js/blob/main/docs/ARCHITECTURE.md"
          title="docs/ARCHITECTURE.md"
          desc="Deep dive: modules, data flow, cache key recipe, ePub round-trip invariants."
        />
      </div>
    </Section>
  );
}

function DocLink({
  href,
  title,
  desc,
}: {
  href: string;
  title: string;
  desc: string;
}): React.JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="group block rounded-lg border bg-card/40 p-4 transition-colors hover:border-primary/50 hover:bg-accent/20"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-foreground">{title}</span>
        <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{desc}</p>
    </a>
  );
}

function ExternalDocLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-foreground"
    >
      {children}
      <ExternalLink className="size-3" />
    </a>
  );
}

/* -------------------------------------------------------------------------- */
/*  Tiny hooks.                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `useLocation().hash` from `react-router-dom` is fine, but importing
 * the router hook for one boolean adds a coupling we don't otherwise
 * need on this page. We watch `window.location.hash` directly and
 * react to `hashchange` events.
 */
function useLocationHash(): { hash: string } {
  const [hash, setHash] = React.useState(() =>
    typeof window === "undefined" ? "" : window.location.hash,
  );
  React.useEffect(() => {
    const onHashChange = (): void => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return { hash };
}
