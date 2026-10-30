import { useMemo, useState } from 'react';
import type {
  NodeDefinitionCatalogItem,
  WorkflowGraphContract,
} from '@pertexo/contracts';
import { WORKFLOW_FAILURE_PORT } from '@pertexo/workflow-model';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { StatusGlyph } from '@/components/ui/status';
import { Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import {
  failureLink,
  failureTargetOptions,
} from '../../model/failure-routing/commands';
import { canOwnFailureLink } from '../../model/failure-routing/eligibility';
import { stepTitle } from '../../model/graph/adapter';
import { linkWorkflowNodes } from '../../model/graph/commands';
import type { EditorStore } from '../../model/state/store';

type Node = WorkflowGraphContract['nodes'][number];
export function FailureSetup({
  node,
  graph,
  definitions,
  editable,
  store,
  onAdd,
  onRemove,
  onSelect,
}: Readonly<{
  node: Node;
  graph: WorkflowGraphContract;
  definitions: readonly NodeDefinitionCatalogItem[];
  editable: boolean;
  store: EditorStore;
  onAdd: (nodeId: string, opener: HTMLElement) => void;
  onRemove: (edgeId: string) => void;
  onSelect: (nodeId: string) => void;
}>) {
  const [open, setOpen] = useState(false);
  const edge = failureLink(graph, node.id);
  const target = graph.nodes.find((n) => n.id === edge?.target.nodeId);
  if (!canOwnFailureLink(graph, node.id)) return null;
  return (
    <Field className="mt-2 border-t border-border pt-4">
      <FieldLabel>On failure</FieldLabel>
      <FieldDescription>
        After the last automatic retry,{' '}
        {edge === undefined ? 'stop this run.' : 'follow this failure link.'}{' '}
        Unknown outcomes and requested stops keep their own behavior.
      </FieldDescription>
      {edge === undefined ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!editable}
          onClick={() => {
            setOpen(true);
          }}
        >
          Follow failure link
        </Button>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <StatusGlyph tone="failure" />
          <span>
            {target === undefined ? 'Missing handler' : stepTitle(target)}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              onSelect(edge.target.nodeId);
            }}
          >
            View handler
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={!editable}
            onClick={() => {
              onRemove(edge.id);
            }}
          >
            Remove failure path
          </Button>
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? (
          <HandlerChoices
            graph={graph}
            source={node}
            definitions={definitions}
            editable={editable}
            store={store}
            onAdd={(opener) => {
              setOpen(false);
              onAdd(node.id, opener);
            }}
            onClose={() => {
              setOpen(false);
            }}
          />
        ) : null}
      </Dialog>
    </Field>
  );
}
function HandlerChoices({
  graph,
  source,
  definitions,
  editable,
  store,
  onAdd,
  onClose,
}: Readonly<{
  graph: WorkflowGraphContract;
  source: Node;
  definitions: readonly NodeDefinitionCatalogItem[];
  editable: boolean;
  store: EditorStore;
  onAdd: (opener: HTMLElement) => void;
  onClose: () => void;
}>) {
  const targets = useMemo(
    () => failureTargetOptions(graph, source.id, definitions),
    [graph, source.id, definitions],
  );
  return (
    <DialogContent className="max-h-[85svh] overflow-y-auto">
      <div className="flex flex-col gap-2">
        <DialogTitle>Follow a failure link</DialogTitle>
        <DialogDescription>
          Choose an available handler for {stepTitle(source)}, or add a step.
          Handlers are separate sequential paths and can end in Stop run. They
          cannot join the normal path.
        </DialogDescription>
      </div>
      <div className="flex flex-col gap-2">
        {targets.map((target) => (
          <Button
            type="button"
            key={target.nodeId}
            variant="outline"
            disabled={!editable}
            onClick={() => {
              const state = store.getState();
              if (state.save.status === 'conflict') return;
              const next = linkWorkflowNodes(state.graph, {
                source: source.id,
                sourceHandle: WORKFLOW_FAILURE_PORT,
                target: target.nodeId,
                targetHandle: target.port,
              });
              if (next === null) return;
              state.transact(next);
              onClose();
            }}
          >
            {target.label}
          </Button>
        ))}
      </div>
      {targets.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No existing step can be this handler. Add an action or a final Stop
          run. Failure paths support Conditions and final Stop run steps. Loops,
          joins, Wait and Call workflow are not supported.
        </p>
      ) : null}
      <Button
        type="button"
        disabled={!editable}
        onClick={(event) => {
          onAdd(event.currentTarget);
        }}
      >
        Add handler step…
      </Button>
    </DialogContent>
  );
}
