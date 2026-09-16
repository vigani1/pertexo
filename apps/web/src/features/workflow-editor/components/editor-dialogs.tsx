import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { useEditorStore } from '../model/editor-store-context';

export function ConflictDialog() {
  const conflict = useEditorStore((state) => state.conflict);
  const saveStatus = useEditorStore((state) => state.saveStatus);
  const discardLocalAndUseRemote = useEditorStore(
    (state) => state.discardLocalAndUseRemote,
  );
  const acceptRemoteForReview = useEditorStore(
    (state) => state.acceptRemoteForReview,
  );
  return (
    <Dialog open={conflict !== null && saveStatus === 'conflict'}>
      <DialogContent>
        <DialogTitle>This draft changed elsewhere</DialogTitle>
        <DialogDescription>
          Autosave stopped and both graphs are intact. To continue safely, use
          the server draft as the new baseline and manually reapply chosen edits
          from the retained local comparison.
        </DialogDescription>
        {conflict === null ? null : (
          <dl className="mt-5 grid grid-cols-2 gap-3 rounded-lg border bg-background/50 p-4 text-sm">
            <div>
              <dt className="text-muted-foreground">Local</dt>
              <dd>
                {conflict.local.nodes.length} nodes,{' '}
                {conflict.local.edges.length} edges
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Server</dt>
              <dd>
                {conflict.remote.nodes.length} nodes,{' '}
                {conflict.remote.edges.length} edges
              </dd>
            </div>
          </dl>
        )}
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={acceptRemoteForReview}
          >
            Keep local for review
          </Button>
          <Button type="button" onClick={discardLocalAndUseRemote}>
            Discard local and reload
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ConflictComparisonNotice() {
  const conflict = useEditorStore((state) => state.conflict);
  const saveStatus = useEditorStore((state) => state.saveStatus);
  const dismiss = useEditorStore((state) => state.dismissConflictComparison);
  if (conflict === null || saveStatus === 'conflict') return null;
  return (
    <section
      className="border-b border-secondary/25 bg-secondary/5 px-4 py-3"
      aria-label="Retained local conflict comparison"
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Local edits retained for review</p>
          <p className="mt-1 text-xs text-muted-foreground">
            The server draft is now the save baseline. Review the local copy and
            manually reapply only the edits you still want.
          </p>
          <details className="mt-2 text-xs">
            <summary className="w-fit cursor-pointer text-secondary">
              Compare graph JSON
            </summary>
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <GraphComparison label="Retained local" graph={conflict.local} />
              <GraphComparison
                label="Accepted server"
                graph={conflict.remote}
              />
            </div>
          </details>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={dismiss}>
          Dismiss comparison
        </Button>
      </div>
    </section>
  );
}

function GraphComparison({
  label,
  graph,
}: Readonly<{
  label: string;
  graph: WorkflowGraphContract;
}>) {
  return (
    <div className="min-w-0 rounded-lg border bg-background/60 p-3">
      <p className="font-medium text-muted-foreground">{label}</p>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
        {JSON.stringify(graph, null, 2)}
      </pre>
    </div>
  );
}

export function LeaveEditorDialog({
  blocker,
  retainedComparison,
}: Readonly<{
  blocker:
    | Readonly<{ status: 'idle' }>
    | Readonly<{
        status: 'blocked';
        proceed: () => void;
        reset: () => void;
      }>;
  retainedComparison: boolean;
}>) {
  return (
    <Dialog
      open={blocker.status === 'blocked'}
      onOpenChange={(open) => {
        if (!open && blocker.status === 'blocked') blocker.reset();
      }}
    >
      <DialogContent>
        <DialogTitle>
          {retainedComparison
            ? 'Discard the retained comparison?'
            : 'Leave with unapplied changes?'}
        </DialogTitle>
        <DialogDescription>
          {retainedComparison
            ? 'The local conflict comparison has not been dismissed. Leaving now will discard it from this browser tab.'
            : 'This editor has unsaved graph changes or inspector changes that have not been applied. Leaving now will discard them.'}
        </DialogDescription>
        {blocker.status === 'blocked' ? (
          <div className="mt-6 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={blocker.reset}>
              Stay here
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={blocker.proceed}
            >
              {retainedComparison ? 'Discard and leave' : 'Leave editor'}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function UnappliedChangesDialog({
  open,
  action,
  onApply,
  onDiscard,
  onStay,
}: Readonly<{
  open: boolean;
  action: 'delete' | 'history' | 'selection';
  onApply: () => void;
  onDiscard: () => void;
  onStay: () => void;
}>) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onStay();
      }}
    >
      <DialogContent>
        <DialogTitle>Resolve unapplied changes</DialogTitle>
        <DialogDescription>
          {action === 'selection'
            ? 'Apply or discard the current inspector edits before switching nodes.'
            : action === 'delete'
              ? 'Apply or discard the current inspector edits before deleting this node.'
              : 'Apply or discard the current inspector edits before using undo or redo.'}
        </DialogDescription>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onStay}>
            Stay
          </Button>
          <Button type="button" variant="outline" onClick={onDiscard}>
            Discard changes
          </Button>
          <Button type="button" onClick={onApply}>
            Apply changes
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
