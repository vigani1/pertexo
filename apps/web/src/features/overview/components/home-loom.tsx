import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { StatusGlyph, type StatusTone } from '@/components/ui/status';
import { statusToneText } from '@/components/ui/status-tone';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { RunLoom } from '@/features/workflow-runs/loom.public';
import {
  loomStatisticsQueryOptions,
  runLoomQueryOptions,
} from '@/features/workflow-runs/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { HomeBlockBody } from './home-block';
import { queryBlockState } from '../model/home-block-state';
import { loomCaption } from '../model/loom-caption';

const windows = {
  '1h': { ms: 3_600_000, label: '1 hour', phrase: 'the last hour' },
  '6h': { ms: 21_600_000, label: '6 hours', phrase: 'the last 6 hours' },
  '24h': { ms: 86_400_000, label: '24 hours', phrase: 'the last 24 hours' },
  '7d': { ms: 604_800_000, label: '7 days', phrase: 'the last 7 days' },
} as const;

type LoomWindow = keyof typeof windows;

const legend: readonly (readonly [StatusTone, string])[] = [
  ['live', 'running'],
  ['success', 'succeeded'],
  ['failure', 'failed'],
  ['waiting', 'waiting'],
];

function isLoomWindow(value: string | undefined): value is LoomWindow {
  return value !== undefined && Object.hasOwn(windows, value);
}

/**
 * Home's hero: the Loom over the last hour, 6 or 24 hours, or 7 days. It
 * draws individual runs, while its caption and lane totals come from the
 * exact statistics read, so a capped drawing never passes for the whole.
 */
export function HomeLoom({
  apiClient,
  userId,
  workspaceId,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
}>) {
  const [windowKey, setWindowKey] = useState<LoomWindow>('1h');
  const selected = windows[windowKey];
  // Switching the window keeps the last one drawn until the new one lands,
  // so the page below never collapses and jumps back.
  const loom = useQuery({
    ...runLoomQueryOptions(apiClient, userId, workspaceId, selected.ms),
    placeholderData: keepPreviousData,
  });
  const statistics = useQuery({
    ...loomStatisticsQueryOptions(apiClient, userId, workspaceId, windowKey),
    placeholderData: keepPreviousData,
  });
  const laneTotals = useMemo(
    () =>
      statistics.data?.workflows === undefined ||
      statistics.data.workflows === null
        ? undefined
        : new Map(
            statistics.data.workflows.items.map(
              (workflow) => [workflow.workflowId, workflow.total] as const,
            ),
          ),
    [statistics.data],
  );
  const caption = loomCaption({
    phrase: selected.phrase,
    capped: loom.data?.capped === true,
    total: statistics.data?.window.total,
  });
  return (
    <section aria-labelledby="home-loom-title" className="flex flex-col gap-3">
      <h2 id="home-loom-title" className="sr-only">
        Runs over {selected.phrase}
      </h2>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ToggleGroup
          aria-label="Time window"
          value={[windowKey]}
          onValueChange={(values) => {
            const [next] = values;
            if (isLoomWindow(next)) setWindowKey(next);
          }}
        >
          {Object.entries(windows).map(([key, option]) => (
            <ToggleGroupItem key={key} value={key}>
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <ul
          aria-label="Legend"
          className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-subtle-foreground"
        >
          {legend.map(([tone, label]) => (
            <li key={tone} className="inline-flex items-center gap-1.5">
              {/* Each glyph in its status colour, as the Loom draws it. */}
              <StatusGlyph tone={tone} className={statusToneText[tone]} />
              {label}
            </li>
          ))}
        </ul>
      </div>
      <HomeBlockBody title="Recent runs" state={queryBlockState(loom)}>
        <RunLoom
          runs={loom.data?.runs ?? []}
          windowMs={selected.ms}
          windowLabel={selected.phrase}
          workspaceId={workspaceId}
          laneTotals={laneTotals}
        />
        {caption === undefined ? null : (
          <p className="text-xs text-subtle-foreground">{caption}</p>
        )}
      </HomeBlockBody>
    </section>
  );
}
