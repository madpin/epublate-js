/**
 * Settings → Embeddings card.
 *
 * Surfaces the curator-side knobs introduced by the embeddings
 * retrieval layer:
 *
 * - Provider picker (`none` / `openai-compat` / `local`).
 * - Model + dim + batch size + custom $/Mtok input.
 * - Per-embedding endpoint overrides (so the curator can point
 *   embeddings at a different OpenAI-compatible host than the LLM).
 * - "Test" button — sends a single-string `embed()` call so the
 *   curator can confirm the endpoint reachability without queuing a
 *   real backfill.
 * - "Download model" button for the local provider — surfaces the
 *   one-time consent dialog before the first weights fetch.
 *
 * The card is tightly scoped to embedding state and does not touch
 * the existing LLM endpoint card. The "Embeddings" toggle defaults
 * to `none`, so projects that never opt in behave exactly as v1.
 */

import * as React from "react";
import { Loader2, PlugZap, Download, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  type LibraryEmbeddingConfig,
  DEFAULT_EMBEDDING_CONFIG,
} from "@/db/schema";
import { useAppStore } from "@/state/app";
import {
  buildEmbeddingProvider,
} from "@/llm/embeddings/factory";
import {
  APPROX_LOCAL_MODEL_BYTES,
  DEFAULT_LOCAL_MODEL,
  DEFAULT_LOCAL_DIM,
  HF_BASE_URL,
  grantLocalEmbeddingConsent,
  hasLocalEmbeddingConsent,
  revokeLocalEmbeddingConsent,
} from "@/llm/embeddings/local";
import {
  EmbeddingConsentRequiredError,
  EmbeddingError,
} from "@/llm/embeddings/base";

const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_OPENAI_EMBEDDING_DIM = 1536;

export function EmbeddingsCard(): React.JSX.Element {
  const llm = useAppStore((s) => s.llm);
  const setLlmConfig = useAppStore((s) => s.setLlmConfig);

  const embedding = llm.embedding ?? DEFAULT_EMBEDDING_CONFIG;

  const [provider, setProvider] = React.useState<
    LibraryEmbeddingConfig["provider"]
  >(embedding.provider);
  const [model, setModel] = React.useState(embedding.model);
  const [dim, setDim] = React.useState(String(embedding.dim));
  const [batch_size, setBatchSize] = React.useState(
    String(embedding.batch_size),
  );
  const [base_url, setBaseUrl] = React.useState(embedding.base_url ?? "");
  const [api_key, setApiKey] = React.useState(embedding.api_key ?? "");
  const [price, setPrice] = React.useState(
    embedding.price_per_mtok != null ? String(embedding.price_per_mtok) : "",
  );

  const [testing, setTesting] = React.useState(false);
  const [consent_open, setConsentOpen] = React.useState(false);
  const [consent_granted, setConsentGranted] = React.useState(
    hasLocalEmbeddingConsent(),
  );
  const [model_change_open, setModelChangeOpen] = React.useState(false);

  React.useEffect(() => {
    setProvider(embedding.provider);
    setModel(embedding.model);
    setDim(String(embedding.dim));
    setBatchSize(String(embedding.batch_size));
    setBaseUrl(embedding.base_url ?? "");
    setApiKey(embedding.api_key ?? "");
    setPrice(
      embedding.price_per_mtok != null
        ? String(embedding.price_per_mtok)
        : "",
    );
  }, [embedding]);

  const onProviderChange = (
    next: LibraryEmbeddingConfig["provider"],
  ): void => {
    setProvider(next);
    if (next === "local") {
      setModel(DEFAULT_LOCAL_MODEL);
      setDim(String(DEFAULT_LOCAL_DIM));
    } else if (next === "openai-compat") {
      // Reset to OpenAI-friendly defaults if the curator was just on
      // a local model — keeps copy-paste workflows quick.
      setModel((cur) =>
        cur && cur !== DEFAULT_LOCAL_MODEL
          ? cur
          : DEFAULT_OPENAI_EMBEDDING_MODEL,
      );
      setDim((cur) =>
        cur && cur !== String(DEFAULT_LOCAL_DIM)
          ? cur
          : String(DEFAULT_OPENAI_EMBEDDING_DIM),
      );
    }
  };

  const buildPatch = (): LibraryEmbeddingConfig => {
    const dim_n = Math.max(1, Math.floor(Number(dim) || 1));
    const batch_n = Math.max(1, Math.floor(Number(batch_size) || 64));
    const price_n = price.trim() === "" ? null : Number(price);
    return {
      provider,
      model: model.trim() || DEFAULT_EMBEDDING_CONFIG.model,
      dim: dim_n,
      batch_size: batch_n,
      base_url: base_url.trim() || null,
      api_key: api_key.trim() || null,
      price_per_mtok:
        price_n != null && Number.isFinite(price_n) ? price_n : null,
    };
  };

  const save = async (): Promise<void> => {
    await setLlmConfig({ embedding: buildPatch() });
    toast.success("Embedding config saved.");
  };

  /**
   * Was a previous (non-`none`) embedding provider configured? Used to
   * gate the model-change warning so flipping `none → openai-compat`
   * (the very first opt-in) doesn't trigger a useless dialog.
   */
  const had_previous_embeddings =
    embedding.provider !== "none" && Boolean(embedding.model);

  /**
   * Did anything that affects vector compatibility change between
   * the persisted config and the form's pending values? Provider,
   * model, and dim each map to a distinct vector space — changing
   * any of them invalidates existing rows for retrieval purposes.
   */
  const config_changed =
    provider !== embedding.provider ||
    model.trim() !== embedding.model ||
    Math.max(1, Math.floor(Number(dim) || 1)) !== embedding.dim;

  const onSaveClick = (): void => {
    if (had_previous_embeddings && config_changed && provider !== "none") {
      setModelChangeOpen(true);
      return;
    }
    void save();
  };

  const confirmSaveAfterChange = async (): Promise<void> => {
    setModelChangeOpen(false);
    await save();
  };

  const test = async (): Promise<void> => {
    if (provider === "none") {
      toast.error("Pick a provider first.");
      return;
    }
    setTesting(true);
    try {
      const patch = buildPatch();
      const { provider: built } = await buildEmbeddingProvider({
        configOverride: { ...llm, embedding: patch },
        // Loose-mode probe: don't throw if the server returns a
        // different dim. Some providers (e.g. Voyage's voyage-3.5
        // at 1024-dim) will mismatch the OpenAI-default 1536, and
        // the curator would never get past the guard rail otherwise.
        validate_dim: false,
      });
      if (!built) {
        toast.error("Provider build returned null.");
        return;
      }
      const t0 = performance.now();
      const result = await built.embed(["epublate ping"]);
      const dt = Math.round(performance.now() - t0);
      const v = result.vectors[0];
      if (!v) {
        toast.error("Embedding probe returned no vectors.");
        return;
      }
      if (v.length !== patch.dim) {
        const detected = v.length;
        toast.warning(
          `Test succeeded in ${dt} ms but the model returned ` +
            `${detected}-dim vectors, not the configured ${patch.dim}. ` +
            `Updated the dim field — click Save to persist.`,
          { duration: 12_000 },
        );
        // Auto-correct the field so the curator just has to hit Save.
        setDim(String(detected));
        return;
      }
      toast.success(
        `Embedded a 1-string probe in ${dt} ms — ${v.length}-dim ` +
          `vector via ${built.model}.`,
      );
    } catch (err: unknown) {
      if (err instanceof EmbeddingConsentRequiredError) {
        setConsentOpen(true);
      } else if (err instanceof EmbeddingError) {
        toast.error(err.message, { duration: 12_000 });
      } else {
        toast.error(
          `Embedding test failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { duration: 12_000 },
        );
      }
    } finally {
      setTesting(false);
    }
  };

  const onGrantConsent = (): void => {
    grantLocalEmbeddingConsent();
    setConsentGranted(true);
    setConsentOpen(false);
    toast.success(
      "Local model download is now enabled. Click Test to fetch the weights.",
    );
  };

  const onRevokeConsent = async (): Promise<void> => {
    revokeLocalEmbeddingConsent();
    setConsentGranted(false);
    toast.success(
      "Consent revoked. The cached weights remain on disk; clear browser " +
        "storage to remove them.",
    );
  };

  const provider_disabled = provider === "none";
  const local_provider = provider === "local";
  const compat_provider = provider === "openai-compat";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Embeddings</CardTitle>
        <CardDescription>
          Optional retrieval layer for Lore-Book attachments, the
          cross-chapter <code>relevant</code> context mode, and
          proposed-entry hints. Defaults to off; turning it on adds one
          background pass per project plus a small per-segment cost.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="emb_provider">Provider</Label>
          <select
            id="emb_provider"
            value={provider}
            onChange={(e) =>
              onProviderChange(
                e.target.value as LibraryEmbeddingConfig["provider"],
              )
            }
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="none">None — embeddings disabled (default)</option>
            <option value="openai-compat">
              OpenAI-compatible (API)
            </option>
            <option value="local">
              Local (@xenova/transformers, on-device)
            </option>
          </select>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="grid gap-2">
            <Label htmlFor="emb_model">Model</Label>
            <Input
              id="emb_model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={
                local_provider
                  ? DEFAULT_LOCAL_MODEL
                  : DEFAULT_OPENAI_EMBEDDING_MODEL
              }
              disabled={provider_disabled}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="emb_dim">Dim</Label>
            <Input
              id="emb_dim"
              type="number"
              min={1}
              value={dim}
              onChange={(e) => setDim(e.target.value)}
              disabled={provider_disabled}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="emb_batch">Batch size</Label>
            <Input
              id="emb_batch"
              type="number"
              min={1}
              value={batch_size}
              onChange={(e) => setBatchSize(e.target.value)}
              disabled={provider_disabled}
            />
          </div>
        </div>

        {compat_provider ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="emb_base_url">Embedding base URL (optional)</Label>
              <Input
                id="emb_base_url"
                value={base_url}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="(falls back to LLM endpoint)"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="emb_api_key">Embedding API key (optional)</Label>
              <Input
                id="emb_api_key"
                type="password"
                value={api_key}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="(falls back to LLM key)"
                className="font-mono text-xs"
              />
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="emb_price">Custom $/Mtok (optional)</Label>
            <Input
              id="emb_price"
              type="number"
              step="0.0001"
              min={0}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="(use built-in pricing)"
              disabled={provider_disabled}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Overrides the package-default price for this model in the
              cost meter. Local models are always $0.
            </p>
          </div>
          {local_provider ? (
            <div className="grid gap-2">
              <Label>Local model state</Label>
              <div className="flex flex-col gap-2 rounded-md border p-3 text-xs">
                {consent_granted ? (
                  <>
                    <p className="text-muted-foreground">
                      Download approved. The model is fetched lazily on the
                      first <code>embed()</code> call and cached in your
                      browser's Cache Storage.
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void onRevokeConsent()}
                    >
                      Revoke consent
                    </Button>
                  </>
                ) : (
                  <>
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 size-4 text-warning" />
                      <p>
                        Download required. We fetch the model weights from{" "}
                        <code>{HF_BASE_URL}</code> on first use and cache them
                        on this device. No other network calls are added.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setConsentOpen(true)}
                      className="gap-1.5"
                    >
                      <Download className="size-3.5" />
                      Download model
                    </Button>
                  </>
                )}
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={provider_disabled || testing}
            onClick={() => void test()}
            className="gap-2"
            title="Embed a 1-string probe to confirm the endpoint and dim."
          >
            {testing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <PlugZap className="size-4" />
            )}
            {testing ? "Testing…" : "Test"}
          </Button>
          <Button onClick={() => onSaveClick()}>Save</Button>
        </div>
      </CardContent>

      <Dialog open={consent_open} onOpenChange={setConsent}>
        <ConsentDialogContent
          model={model || DEFAULT_LOCAL_MODEL}
          onApprove={onGrantConsent}
          onCancel={() => setConsentOpen(false)}
        />
      </Dialog>

      <Dialog open={model_change_open} onOpenChange={setModelChangeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-warning" />
              Switching embedding models
            </DialogTitle>
            <DialogDescription>
              Embedding vectors are tied to the model that produced
              them — they aren't comparable across models or
              dimensions.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 text-sm">
            <ChangeRow
              label="Provider"
              from={embedding.provider}
              to={provider}
            />
            <ChangeRow label="Model" from={embedding.model} to={model.trim()} />
            <ChangeRow
              label="Dim"
              from={String(embedding.dim)}
              to={String(Math.max(1, Math.floor(Number(dim) || 1)))}
            />
            <p className="text-muted-foreground">
              After saving, the active model becomes{" "}
              <code className="font-mono text-[12px]">
                {model.trim() || DEFAULT_OPENAI_EMBEDDING_MODEL}
              </code>
              . Existing vectors in every project (and Lore Book) stay on
              disk but won't rank against new queries — open each
              project's <em>Settings → Embedding inventory</em> card and
              click <em>Re-embed everything</em> to refresh them.
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setModelChangeOpen(false)}
            >
              Cancel
            </Button>
            <Button onClick={() => void confirmSaveAfterChange()}>
              Save anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );

  function setConsent(open: boolean): void {
    if (!open) setConsentOpen(false);
  }
}

function ConsentDialogContent({
  model,
  onApprove,
  onCancel,
}: {
  model: string;
  onApprove(): void;
  onCancel(): void;
}): React.JSX.Element {
  const mb = (APPROX_LOCAL_MODEL_BYTES / (1024 * 1024)).toFixed(0);
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Download local embedding model?</DialogTitle>
        <DialogDescription>
          This is the only third-party network call epublate makes outside
          the configured LLM endpoint, and it happens at most once per
          model.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3 text-sm">
        <p>
          We'll fetch <code>{model}</code> from{" "}
          <code>{HF_BASE_URL}</code> (~{mb} MB) and cache it in your
          browser's Cache Storage. After that, every <code>embed()</code>{" "}
          call runs entirely on-device.
        </p>
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li>The download happens once per model, in the foreground.</li>
          <li>
            Subsequent sessions reuse the cached weights — no further
            network calls.
          </li>
          <li>
            Revoke consent any time from Settings → Embeddings. The cached
            weights survive consent revocation; clear browser storage to
            remove them.
          </li>
        </ul>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onApprove}>I understand — download</Button>
      </DialogFooter>
    </DialogContent>
  );
}

function ChangeRow({
  label,
  from,
  to,
}: {
  label: string;
  from: string;
  to: string;
}): React.JSX.Element {
  const same = from === to;
  return (
    <div className="grid grid-cols-[5rem_1fr] items-baseline gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-[12px]">
        <span className={same ? "text-muted-foreground" : "line-through opacity-60"}>
          {from || "(empty)"}
        </span>
        {same ? null : (
          <>
            <span className="mx-2 text-muted-foreground">→</span>
            <span className="text-foreground">{to || "(empty)"}</span>
          </>
        )}
      </span>
    </div>
  );
}
