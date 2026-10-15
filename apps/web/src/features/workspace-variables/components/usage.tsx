import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { variableUsageQueryOptions } from '../data/variables.queries';
import type { VariablesScope } from '../data/variables.api';
function VariableUsage({
  scope,
  name,
  onRemove,
}: Readonly<{ scope: VariablesScope; name: string; onRemove?: () => void }>) {
  const query = useInfiniteQuery(variableUsageQueryOptions(scope, name));
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  const incomplete = query.data?.pages.some((page) => page.incomplete) === true;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Current drafts and current publications, including archived workflows.
        Retained historical versions and run snapshots keep their own values.
      </p>
      {query.isPending ? (
        <p role="status">Checking workflow references…</p>
      ) : null}
      {query.isError ? (
        <Notice
          tone="warning"
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void query.refetch()}
            >
              Restart check
            </Button>
          }
        >
          References could not be checked completely. Removing this name may
          break new runs.
        </Notice>
      ) : null}
      {incomplete ? (
        <Notice tone="warning">
          Some draft expressions are invalid and could not be analysed. Fix them
          before relying on this check.
        </Notice>
      ) : null}
      <ul className="flex flex-col divide-y divide-border">
        {rows.map((row) => (
          <li key={`${row.workflowId}:${row.id}`} className="py-3 text-sm">
            <Link
              className="text-action underline underline-offset-4"
              to="/w/$workspaceId/workflows/$workflowId"
              params={{
                workspaceId: scope.workspaceId,
                workflowId: row.workflowId,
              }}
            >
              {row.workflowName}
            </Link>
            <p className="mt-1 break-words text-muted-foreground">
              {row.stage === 'draft' ? 'Draft' : 'Published'}
              {row.archived ? ' · archived' : ''} · {row.label} → {row.input}
            </p>
            {row.kind === 'dynamic' ? (
              <p className="text-xs text-muted-foreground">
                Computed lookup or whole-map expression; may use any variable.
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      {!query.isPending && !query.isError && rows.length === 0 ? (
        <p className="text-sm">
          {query.hasNextPage
            ? 'No matches in the workflows checked so far. Continue the check.'
            : incomplete
              ? 'No parsed reference found; the check is incomplete.'
              : 'No current draft or publication references this name.'}
        </p>
      ) : null}
      {query.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'Checking…' : 'Check more workflows'}
        </Button>
      ) : null}
      {onRemove === undefined ? null : (
        <>
          <Notice tone="warning">
            Removing a name does not rewrite these references. New runs that
            require it will fail; existing snapshots stay unchanged.
          </Notice>
          <Button
            type="button"
            variant="destructive"
            disabled={query.isPending}
            onClick={onRemove}
          >
            Remove from draft
          </Button>
        </>
      )}
    </div>
  );
}

export function VariableUsageDialog({
  scope,
  name,
  onClose,
  onRemove,
}: Readonly<{
  scope: VariablesScope;
  name: string;
  onClose: () => void;
  onRemove?: () => void;
}>) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <div className="mb-4 flex flex-col gap-2">
          <DialogTitle>References to {name}</DialogTitle>
          <DialogDescription>
            Check current uses before changing this shared name.
          </DialogDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mb-4"
          onClick={onClose}
        >
          Close references
        </Button>
        <VariableUsage
          scope={scope}
          name={name}
          {...(onRemove === undefined ? {} : { onRemove })}
        />
      </DialogContent>
    </Dialog>
  );
}
