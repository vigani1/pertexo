import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { MinusIcon, PencilIcon, PlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  diffWorkflowGraphs,
  type StepChangeAspect,
} from '@/features/workflow-drafts/public';
import { useEditorStore } from '../../model/editor-store-context';
import { stepTitle } from '../../model/graph-adapter';
import { adoptStepFrom } from '../../model/graph-copies';

const aspectWords: Readonly<Record<StepChangeAspect, string>> = {
  label: 'name',
  setup: 'setup',
  inputs: 'inputs',
  connections: 'connection',
  enabled: 'on/off',
  position: 'position',
  type: 'type',
};

type Line = Readonly<{
  nodeId: string;
  name: string;
  kind: 'added' | 'removed' | 'changed';
  detail?: string;
}>;

/**
 * What differs between your copy and theirs, step by step, with the raw
 * JSON as a secondary view. Once you keep their version, each difference
 * can be re-applied from your copy as an ordinary, undoable edit.
 */
export function ConflictCompareDialog({
  open,
  onOpenChange,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void }>) {
  const conflict = useEditorStore((state) => state.conflict);
  const inConflict = useEditorStore((state) => state.saveStatus === 'conflict');
  const graph = useEditorStore((state) => state.graph);
  const transact = useEditorStore((state) => state.transact);
  if (conflict === null) return null;
  const lines = compareLines(
    inConflict ? conflict.remote : graph,
    conflict.local,
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>Your copy and theirs</DialogTitle>
        <DialogDescription>
          {inConflict
            ? 'Choose Keep mine to continue from their version with your copy beside it, then re-apply the steps you still want.'
            : 'Steps where your copy differs from the draft you’re editing now. Use mine re-applies one as a normal edit you can undo.'}
        </DialogDescription>
        <Tabs defaultValue="steps" className="mt-4">
          <TabsList>
            <TabsTrigger value="steps">Steps</TabsTrigger>
            <TabsTrigger value="json">JSON</TabsTrigger>
          </TabsList>
          <TabsContent value="steps" className="pt-4">
            {lines.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No step differences: only the layout differs.
              </p>
            ) : (
              <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto pr-1">
                {lines.map((line) => (
                  <li
                    key={line.nodeId}
                    className="flex items-center gap-3 text-sm"
                  >
                    <LineIcon kind={line.kind} />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{line.name}</span>
                      <span className="text-subtle-foreground">
                        {' '}
                        · {lineWords(line)}
                      </span>
                    </span>
                    {inConflict ? null : (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        aria-label={`Use your copy of ${line.name}`}
                        onClick={() => {
                          transact(
                            adoptStepFrom(graph, conflict.local, line.nodeId),
                          );
                        }}
                      >
                        Use mine
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
          <TabsContent value="json" className="grid gap-3 pt-4 lg:grid-cols-2">
            <GraphJson label="Your copy" graph={conflict.local} />
            <GraphJson
              label={inConflict ? 'Their version' : 'Draft now'}
              graph={inConflict ? conflict.remote : graph}
            />
          </TabsContent>
        </Tabs>
        <div className="mt-6 flex justify-end">
          <DialogClose render={<Button type="button" variant="ghost" />}>
            Close
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function compareLines(
  theirs: WorkflowGraphContract,
  mine: WorkflowGraphContract,
): readonly Line[] {
  const diff = diffWorkflowGraphs(theirs, mine, { ignoreLayout: true });
  return [
    ...diff.added.map((node) => ({
      nodeId: node.id,
      name: stepTitle(node),
      kind: 'added' as const,
    })),
    ...diff.removed.map((node) => ({
      nodeId: node.id,
      name: stepTitle(node),
      kind: 'removed' as const,
    })),
    ...diff.changed.map((change) => ({
      nodeId: change.after.id,
      name: stepTitle(change.after),
      kind: 'changed' as const,
      detail: change.aspects.map((aspect) => aspectWords[aspect]).join(', '),
    })),
  ];
}

function lineWords(line: Line): string {
  if (line.kind === 'added') return 'only in your copy';
  if (line.kind === 'removed') return 'not in your copy';
  return `your ${line.detail ?? 'setup'} differs`;
}

function LineIcon({ kind }: Readonly<{ kind: Line['kind'] }>) {
  const Icon =
    kind === 'added' ? PlusIcon : kind === 'removed' ? MinusIcon : PencilIcon;
  const tone =
    kind === 'added'
      ? 'text-success'
      : kind === 'removed'
        ? 'text-destructive'
        : 'text-secondary';
  return <Icon aria-hidden="true" className={`size-3.5 shrink-0 ${tone}`} />;
}

function GraphJson({
  label,
  graph,
}: Readonly<{ label: string; graph: WorkflowGraphContract }>) {
  return (
    <figure className="min-w-0">
      <figcaption className="text-xs font-semibold text-subtle-foreground">
        {label} · {countOf(graph.nodes.length, 'step')},{' '}
        {countOf(graph.edges.length, 'connection')}
      </figcaption>
      <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-white/8 bg-black/25 p-2 font-mono text-[0.7rem] break-all whitespace-pre-wrap">
        {JSON.stringify(graph, null, 2)}
      </pre>
    </figure>
  );
}

function countOf(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}
