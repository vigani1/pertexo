import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { StatusGlyph, type StatusTone } from '@/components/ui/status';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { RunLoom } from '@/features/workflow-runs/loom.public';
import {
  runLoomQueryOptions,
  type RunStatusCounts,
} from '@/features/workflow-runs/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { HomeBlockBody } from './home-block';
import { queryBlockState } from './home-block-state';

const windows = {
  '1h': { ms: 3_600_000, label: '1 hour', phrase: 'the last hour' },
  '6h': { ms: 21_600_000, label: '6 hours', phrase: 'the last 6 hours' },
  '24h': { ms: 86_400_000, label: '24 hours', phrase: 'the last 24 hours' },
} as const;

type LoomWindow = keyof typeof windows;

const legend: readonly (readonly [StatusTone, string])[] = [
  ['live', 'running'],
  ['success', 'done'],
  ['failure', 'failed'],
  ['waiting', 'waiting'],
];

function isLoomWindow(value: string | undefined): value is LoomWindow {
  return value === '1h' || value === '6h' || value === '24h';
}

/**
 * Home's hero: the Loom over the last 1, 6 or 24 hours. Runs still active
 * from before the window are added from the live counts so every running
 * thread reaches the Core.
 */
export function HomeLoom({
  apiClient,
  userId,
  workspaceId,
  counts,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  counts: RunStatusCounts | undefined;
}>) {
  const [windowKey, setWindowKey] = useState<LoomWindow>('1h');
  const loom = useQuery(
    runLoomQueryOptions(apiClient, userId, workspaceId, windows[windowKey].ms),
  );
  const runs = useMemo(
    () => [
      ...(loom.data?.runs ?? []),
      ...(counts?.running.runs ?? []),
      ...(counts?.waiting.runs ?? []),
      ...(counts?.queued.runs ?? []),
    ],
    [loom.data, counts],
  );
  return (
    <section aria-labelledby="home-loom-title" className="flex flex-col gap-3">
      <h2 id="home-loom-title" className="sr-only">
        Runs over {windows[windowKey].phrase}
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
              <StatusGlyph tone={tone} />
              {label}
            </li>
          ))}
        </ul>
      </div>
      <HomeBlockBody title="Recent runs" state={queryBlockState(loom)}>
        <RunLoom
          runs={runs}
          windowMs={windows[windowKey].ms}
          windowLabel={windows[windowKey].phrase}
          workspaceId={workspaceId}
        />
        {loom.data?.capped === true ? (
          <p className="text-xs text-subtle-foreground">
            Showing the latest 300 runs in {windows[windowKey].phrase}. Narrow
            the window to see every run.
          </p>
        ) : null}
      </HomeBlockBody>
    </section>
  );
}
