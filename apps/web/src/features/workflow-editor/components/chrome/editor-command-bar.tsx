import type { ReactNode } from 'react';
import {
  ArrowLeftIcon,
  Redo2Icon,
  SaveIcon,
  SettingsIcon,
  Undo2Icon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useEditorStore } from '../../model/editor-store-context';

const statusLabel = {
  clean: 'Saved',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  conflict: 'Save conflict',
  failed: 'Save failed',
  uncertain: 'Checking save…',
} as const;

export function EditorCommandBar({
  workflowId,
  canUpdate,
  onBack,
  onSave,
  onUndo,
  onRedo,
  actions,
  onOpenSettings,
}: Readonly<{
  workflowId: string;
  canUpdate: boolean;
  onBack: () => void;
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
  actions?: ReactNode;
  onOpenSettings: () => void;
}>) {
  const saveStatus = useEditorStore((state) => state.saveStatus);
  const saveError = useEditorStore((state) => state.saveError);
  const canUndo = useEditorStore((state) => state.history.past.length > 0);
  const canRedo = useEditorStore((state) => state.history.future.length > 0);
  return (
    <header className="relative z-20 flex min-h-18 flex-wrap items-center justify-between gap-3 border-b border-white/8 bg-card/75 px-4 py-3 shadow-[0_12px_36px_rgb(0_0_0/18%)] backdrop-blur-xl">
      <div className="flex min-w-0 items-center gap-3">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeftIcon data-icon="inline-start" />
          Back
        </Button>
        <span className="h-8 w-px bg-border" aria-hidden="true" />
        <div className="min-w-0">
          <h1 className="truncate font-heading text-base font-semibold">
            Workflow editor
          </h1>
          <p className="mt-0.5 max-w-64 truncate font-mono text-[0.66rem] text-muted-foreground">
            {workflowId}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span role="status" aria-live="polite">
          <Badge variant={saveStatus === 'clean' ? 'muted' : 'secondary'}>
            {statusLabel[saveStatus]}
          </Badge>
        </span>
        <div className="flex overflow-hidden rounded-lg border border-border bg-background/40">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="rounded-none border-r border-border"
            aria-label="Undo"
            title="Undo"
            disabled={!canUndo}
            onClick={onUndo}
          >
            <Undo2Icon />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="rounded-none"
            aria-label="Redo"
            title="Redo"
            disabled={!canRedo}
            onClick={onRedo}
          >
            <Redo2Icon />
          </Button>
        </div>
        {canUpdate ? (
          <Button
            type="button"
            size="sm"
            variant="solid"
            disabled={
              saveStatus === 'clean' ||
              saveStatus === 'saving' ||
              saveStatus === 'conflict'
            }
            onClick={onSave}
          >
            <SaveIcon data-icon="inline-start" />
            Save now
          </Button>
        ) : null}
        {actions}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Settings"
          title="Workflow settings"
          onClick={onOpenSettings}
        >
          <SettingsIcon />
        </Button>
      </div>
      {saveError === null ? null : (
        <p
          role="alert"
          className="basis-full text-right text-xs text-destructive"
        >
          {saveError}
        </p>
      )}
    </header>
  );
}
