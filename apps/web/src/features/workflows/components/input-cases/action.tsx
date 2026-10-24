import { Suspense, useCallback, useRef, useState } from 'react';
import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
import { lazyPiece } from '@/components/patterns/app-update/lazy';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import { SkeletonLines } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import type { ApiClient } from '@/lib/api/client';
import { useInputCases } from '../../hooks/use-input-cases';
import type { LoadedInputCase } from './panel';

// The case editor loads with the dialog's first open, not with the workflow
// bar that holds its trigger.
const InputCasesPanel = lazyPiece(() =>
  import('./panel').then((module) => module.InputCasesPanel),
);

type InputCasesActionProps = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflow: WorkflowSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerClassName?: string;
  finalFocus?: () => HTMLElement | boolean;
}>;

export function InputCasesAction(props: InputCasesActionProps) {
  if (!props.workspace.capabilities.includes('workflow:read')) return null;
  return (
    <InputCasesDialog
      key={`${props.userId}:${props.workspace.id}:${props.workflow.id}`}
      {...props}
    />
  );
}

function InputCasesDialog({
  apiClient,
  userId,
  workspace,
  workflow,
  open,
  onOpenChange,
  triggerClassName,
  finalFocus,
}: InputCasesActionProps) {
  const cases = useInputCases({
    api: apiClient,
    userId,
    workspaceId: workspace.id,
    workflowId: workflow.id,
    canWrite:
      workspace.status === 'active' &&
      workflow.lifecycleStatus === 'active' &&
      workspace.capabilities.includes('workflow:update'),
    enabled: open,
  });
  const popupRef = useRef<HTMLDivElement>(null);
  const locked = cases.pending || cases.uncertain;
  const [loaded, setLoaded] = useState<LoadedInputCase>();
  const clearLoaded = useCallback(() => {
    setLoaded(undefined);
  }, []);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next || !locked) {
          onOpenChange(next);
        }
      }}
      onOpenChangeComplete={(next) => {
        if (!next) setLoaded(undefined);
      }}
    >
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={triggerClassName}
          />
        }
      >
        Input cases
      </DialogTrigger>
      <DialogContent
        ref={popupRef}
        finalFocus={() => {
          const popup = popupRef.current;
          // A new control may receive focus before this closing popup unmounts.
          // Respect that handoff rather than closing its menu via a late restore.
          if (popup !== null) {
            const focused = popup.ownerDocument.activeElement;
            if (
              focused !== null &&
              focused !== popup.ownerDocument.body &&
              !popup.contains(focused)
            )
              return false;
          }
          return finalFocus?.() ?? true;
        }}
        className="max-h-[calc(100svh-2rem)] overflow-y-auto"
      >
        <DialogTitle>Input cases</DialogTitle>
        <DialogDescription>
          Browse shared run inputs. Nothing here starts or tests a workflow.
        </DialogDescription>
        {/* Let the popup unmount its focused content after the exit transition;
            removing it on close queues focus repair into the next open menu. */}
        <div className="mt-5 flex flex-col gap-5">
          <Suspense fallback={<SkeletonLines label="Loading input cases" />}>
            <InputCasesPanel
              key={`${userId}:${workspace.id}:${workflow.id}`}
              cases={cases}
              onAccessLost={clearLoaded}
              onLoad={setLoaded}
              scope={{ workspace, workflow: workflow }}
            />
          </Suspense>
          {loaded === undefined ? null : (
            <FieldGroup>
              <LabelledField
                id="loaded-case-copy"
                label={
                  <span className="wrap-anywhere">
                    Loaded input: {loaded.name}
                  </span>
                }
                description="Detached copy. Later saved-case changes do not rewrite it. To execute, open Run with input and load the case there."
              >
                {(control) => (
                  <Textarea
                    {...control}
                    readOnly
                    autoComplete="off"
                    spellCheck={false}
                    className="min-h-32 font-mono"
                    value={JSON.stringify(loaded.input, null, 2)}
                  />
                )}
              </LabelledField>
            </FieldGroup>
          )}
          <Button
            type="button"
            variant="ghost"
            disabled={locked}
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Close input cases
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
