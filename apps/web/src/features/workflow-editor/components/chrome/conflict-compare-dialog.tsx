import { useNotifications } from '@/components/ui/use-notifications';
import { WORKFLOW_NOTE_LIMITS } from '@pertexo/workflow-model';
import { adoptWorkflowNote } from '../../model/notes/commands';
import type { WorkflowGraphContract } from '@pertexo/contracts';
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
  type GraphChange,
} from '@/features/workflows/comparison.public';
import { useEditorStore } from '../../model/state/context';
import { adoptStepFrom } from '../../model/graph/copies';

type Line = GraphChange;

/**
 * What differs between your copy and theirs, step by step, with the raw
 * JSON as a secondary view. Once you keep their version, each difference
 * can be re-applied from your copy as an ordinary, undoable edit.
 */
export function ConflictCompareDialog({
  open,
  onOpenChange,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void }>) {
  const notifications = useNotifications();
  const conflict = useEditorStore((state) => state.conflict);
  const inConflict = useEditorStore((state) => state.saveStatus === 'conflict');
  const graph = useEditorStore((state) => state.graph);
  const transact = useEditorStore((state) => state.transact);
  if (conflict === null) return null;
  const comparison = diffWorkflowGraphs(
    inConflict ? conflict.remote : graph,
    conflict.local,
  );
  const lines = comparison.lines;
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
            <TabsTrigger value="steps">Changes</TabsTrigger>
            <TabsTrigger value="json">JSON</TabsTrigger>
          </TabsList>
          <TabsContent value="steps" className="pt-4">
            {lines.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {comparison.layoutOnly
                  ? 'Only step layout differs.'
                  : 'No definition differences.'}
              </p>
            ) : (
              <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto pr-1">
                {lines.map((line) => (
                  <li
                    key={`${line.target}:${line.id}`}
                    className="flex items-center gap-3 text-sm"
                  >
                    <LineIcon kind={line.kind} />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{line.label}</span>
                      <span className="text-subtle-foreground">
                        {' '}
                        · {lineWords(line)}
                      </span>
                    </span>
                    {inConflict ||
                    (line.target !== 'step' &&
                      line.target !== 'note') ? null : (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        aria-label={`Use your copy of ${line.label}`}
                        onClick={() => {
                          const next =
                            line.target === 'step'
                              ? adoptStepFrom(graph, conflict.local, line.id)
                              : adoptWorkflowNote(
                                  graph,
                                  conflict.local,
                                  line.id,
                                );
                          if (next === null)
                            notifications.error({
                              title: `The canvas has ${String(WORKFLOW_NOTE_LIMITS.count)} notes`,
                              description:
                                'Remove a note before applying this one.',
                            });
                          else transact(next);
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

function lineWords(line: Line): string {
  if (line.kind === 'added') return 'only in your copy';
  if (line.kind === 'removed') return 'not in your copy';
  if (line.target !== 'step' && line.target !== 'note')
    return line.detail === undefined
      ? 'different in your copy'
      : `${line.detail} in your copy`;
  return `your ${line.detail ?? 'setup'} differs`;
}

function LineIcon({ kind }: Readonly<{ kind: Line['kind'] }>) {
  const { Icon, tone } = LINE_APPEARANCE[kind];
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
        {countOf(graph.edges.length, 'link')}
      </figcaption>
      <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-surface-ink/8 bg-recess-ink/25 p-2 font-mono text-[0.7rem] break-all whitespace-pre-wrap">
        {JSON.stringify(graph, null, 2)}
      </pre>
    </figure>
  );
}

function countOf(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

const LINE_APPEARANCE = {
  added: { Icon: PlusIcon, tone: 'text-success' },
  removed: { Icon: MinusIcon, tone: 'text-destructive' },
  changed: { Icon: PencilIcon, tone: 'text-secondary' },
} satisfies Record<Line['kind'], { Icon: typeof PlusIcon; tone: string }>;
