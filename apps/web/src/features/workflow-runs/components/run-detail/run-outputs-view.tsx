import { RotateCcwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusGlyph } from '@/components/ui/status';
import { useQuery } from '@tanstack/react-query';
import type { RunTimelineRow } from '../../model/timeline/run-timeline-model';
import { nodeRunOutputQueryOptions } from '../../data/workflow-run-data.queries';
import {
  describeValue,
  isEmptyValue,
} from '../../model/step-inspection/run-data-summary';
import { RunInputData, type RunDataScope } from './run-data';

/** Past this many steps the list names each step's status, not its data. */
const SUMMARISED_STEPS = 25;

/** What a step returned, in a few words: "1 field · 26 B", "file". */
function ResultSummary({
  row,
  scope,
}: Readonly<{ row: RunTimelineRow; scope: RunDataScope }>) {
  const query = useQuery(
    nodeRunOutputQueryOptions(
      scope.apiClient,
      scope.userId,
      scope.workspace.id,
      scope.runId,
      { nodeRunId: row.nodeRunId ?? '', status: row.status },
    ),
  );
  const data = query.data;
  if (data === undefined) return query.isError ? 'couldn’t load' : '…';
  if (data.kind === 'inline' && !isEmptyValue(data.value))
    return describeValue(data.value);
  if (data.kind === 'artifact') return 'file';
  return row.status === 'succeeded'
    ? 'nothing returned'
    : row.statusLabel.toLocaleLowerCase();
}

/**
 * What went in and what came out: the run's input, with Replay from it, and
 * every step that ran, each opening its Data in and Data out in the lens.
 */
export function RunOutputsView({
  rows,
  scope,
  selectedKey,
  canReplay,
  onReplay,
  onSelectStep,
}: Readonly<{
  rows: readonly RunTimelineRow[];
  scope: RunDataScope;
  selectedKey: string | undefined;
  canReplay: boolean;
  onReplay: () => void;
  onSelectStep: (key: string) => void;
}>) {
  const ran = rows.filter((row) => row.nodeRunId !== undefined);
  const summarise = ran.length <= SUMMARISED_STEPS;
  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <section className="min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Run input</h2>
          {canReplay ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onReplay}
            >
              <RotateCcwIcon aria-hidden="true" />
              Replay with this input
            </Button>
          ) : null}
        </div>
        <p className="mt-1 mb-3 text-sm text-muted-foreground">
          What the trigger handed to the first step.
        </p>
        <RunInputData scope={scope} />
      </section>
      <section className="min-w-0">
        <h2 className="text-lg font-semibold">Step results</h2>
        <p className="mt-1 mb-3 text-sm text-muted-foreground">
          Choose a step to see the data it received and returned.
        </p>
        {ran.length === 0 ? (
          <p className="text-sm text-muted-foreground">No step has run yet.</p>
        ) : (
          <ul className="flex flex-col">
            {ran.map((row) => (
              <li key={row.key}>
                <button
                  type="button"
                  aria-current={row.key === selectedKey ? 'true' : undefined}
                  className="flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left outline-none transition-colors hover:bg-white/[0.04] focus-ring aria-[current=true]:bg-action/8 motion-reduce:transition-none"
                  onClick={() => {
                    onSelectStep(row.key);
                  }}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <StatusGlyph tone={row.tone} />
                    <span className="truncate text-sm">{row.label}</span>
                  </span>
                  <span className="shrink-0 font-mono text-xs text-subtle-foreground">
                    {summarise ? (
                      <ResultSummary row={row} scope={scope} />
                    ) : (
                      row.statusLabel.toLocaleLowerCase()
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
