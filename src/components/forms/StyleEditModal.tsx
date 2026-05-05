/**
 * Style guide edit modal — mirrors `epublate.app.modals.StyleEditModal`.
 *
 * Lets the curator pick one of the shipped tone presets and/or edit
 * the prompt-block prose directly. The edited text is what lives on
 * `project.style_guide`; the picked preset id (if any) lives on
 * `project.style_profile` so the dashboard can show the friendly
 * label.
 *
 * Both fields are part of the translator's system-prompt hash, so any
 * edit correctly invalidates the cache for that project.
 */

import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  DEFAULT_STYLE_PROFILE,
  getProfile,
  listProfiles,
} from "@/core/style";
import { openProjectDb } from "@/db/dexie";
import { useFormShortcuts } from "@/hooks/useFormShortcuts";
import { nowMs } from "@/lib/time";

interface StyleEditModalProps {
  project_id: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  current_profile: string | null;
  current_guide: string | null;
}

export function StyleEditModal({
  project_id,
  open,
  onOpenChange,
  current_profile,
  current_guide,
}: StyleEditModalProps): React.JSX.Element {
  const [profile_id, setProfileId] = React.useState<string>(
    current_profile ?? DEFAULT_STYLE_PROFILE,
  );
  const [guide, setGuide] = React.useState<string>(
    current_guide ?? getProfile(DEFAULT_STYLE_PROFILE)?.prompt_block ?? "",
  );
  const [busy, setBusy] = React.useState(false);
  const formRef = React.useRef<HTMLFormElement | null>(null);
  useFormShortcuts(formRef, open);

  React.useEffect(() => {
    if (open) {
      setProfileId(current_profile ?? DEFAULT_STYLE_PROFILE);
      setGuide(
        current_guide ??
          getProfile(current_profile ?? DEFAULT_STYLE_PROFILE)?.prompt_block ??
          "",
      );
    }
  }, [open, current_profile, current_guide]);

  const onProfileChange = (id: string): void => {
    const profile = getProfile(id);
    setProfileId(id);
    if (profile) setGuide(profile.prompt_block);
  };

  const onSave = async (): Promise<void> => {
    setBusy(true);
    try {
      const db = openProjectDb(project_id);
      await db.projects.update(project_id, {
        style_profile: profile_id || null,
        style_guide: guide.trim() || null,
      });
      await db.events.add({
        project_id,
        ts: nowMs(),
        kind: "style.edited",
        payload_json: JSON.stringify({
          profile_id: profile_id || null,
          custom: guide.trim().length > 0,
        }),
      });
      toast.success("Style guide saved.");
      onOpenChange(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Could not save style: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const profile = getProfile(profile_id);
  const guide_matches_template =
    profile != null && guide.trim() === profile.prompt_block.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit style guide</DialogTitle>
          <DialogDescription>
            The translator's system prompt embeds this paragraph
            verbatim. Changes invalidate the cache for the project.
          </DialogDescription>
        </DialogHeader>
        <form
          ref={formRef}
          onSubmit={(ev) => {
            ev.preventDefault();
            void onSave();
          }}
        >
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="se-profile">Tone preset</Label>
            <select
              id="se-profile"
              value={profile_id}
              onChange={(e) => onProfileChange(e.target.value)}
              disabled={busy}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {listProfiles().map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              {profile?.description ??
                "Custom — the prose below will land on the project."}
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="se-guide">
              Style guide
              {guide_matches_template ? (
                <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                  (preset default)
                </span>
              ) : (
                <span className="ml-2 text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400">
                  (customized)
                </span>
              )}
            </Label>
            <Textarea
              id="se-guide"
              value={guide}
              onChange={(e) => setGuide(e.target.value)}
              rows={10}
              disabled={busy}
              className="font-mono text-[11px]"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
