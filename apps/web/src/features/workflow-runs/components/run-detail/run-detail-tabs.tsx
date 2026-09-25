import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import type { WorkflowRunEvent } from '@pertexo/contracts/schemas/workflow-runs';
import { lazy, Suspense, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ApiClient } from '@/lib/api/client';
import type { ThreadView } from '../../model/thread-view';
import { RunEventsView } from './run-events-view';
import { RunLoadingWave } from './run-loading-wave';
import { RunOutputsView } from './run-outputs-view';
import { RunStepList } from './run-step-list';
import { RunThreadView } from './run-thread-view';

type RunTab = 'thread' | 'graph' | 'events' | 'io';

// The map pulls in React Flow; load it only when someone opens the tab.
const RunGraphView = lazy(async () => ({
  default: (await import('./run-graph-view')).RunGraphView,
}));

const graphMessages = {
  loading: 'Loading the exact version this run used…',
  error:
    'The version this run used couldn’t be loaded. The thread and events still show what happened.',
  forbidden: 'Your role can’t view workflows, so the map of steps is hidden.',
} as const;

function GraphPlaceholder({
  message,
  loading,
}: Readonly<{ message: string; loading: boolean }>) {
  return (
    <div className="weave relative grid h-72 place-items-center overflow-hidden rounded-xl border border-white/6 px-6 text-center">
      {loading ? <RunLoadingWave /> : null}
      <p className="relative max-w-sm text-sm text-muted-foreground">
        {message}
      </p>
    </div>
  );
}

/** Thread (default), Graph, Events and Input & output for one run. */
export function RunDetailTabs({
  apiClient,
  userId,
  workspace,
  view,
  nowMs,
  active,
  selectedKey,
  onSelectStep,
  graph,
  graphState,
  events,
  truncatedCount,
  recoveryMessage,
  stepLabel,
  runStartMs,
  compact,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  view: ThreadView;
  nowMs: number;
  active: boolean;
  selectedKey: string | undefined;
  onSelectStep: (key: string) => void;
  graph: WorkflowGraphContract | undefined;
  graphState: keyof typeof graphMessages;
  events: readonly WorkflowRunEvent[];
  truncatedCount: number;
  recoveryMessage: string | undefined;
  stepLabel: (event: WorkflowRunEvent) => string | undefined;
  runStartMs: number;
  /** Phones read the thread as a list of steps. */
  compact: boolean;
}>) {
  const [tab, setTab] = useState<RunTab>('thread');
  const selectedNodeId = view.rows.find(
    (row) => row.key === selectedKey,
  )?.nodeId;
  return (
    <Tabs
      value={tab}
      onValueChange={(value: RunTab) => {
        setTab(value);
      }}
    >
      <TabsList>
        <TabsTrigger value="thread">Thread</TabsTrigger>
        <TabsTrigger value="graph">Graph</TabsTrigger>
        <TabsTrigger value="events">
          Events
          <span className="font-mono text-[0.7rem] text-subtle-foreground">
            {String(events.length + truncatedCount)}
          </span>
        </TabsTrigger>
        <TabsTrigger value="io">Input &amp; output</TabsTrigger>
      </TabsList>
      <TabsContent value="thread" className="pt-5">
        {compact ? (
          <RunStepList
            rows={view.rows}
            active={active}
            selectedKey={selectedKey}
            onSelectStep={onSelectStep}
          />
        ) : (
          <RunThreadView
            view={view}
            nowMs={nowMs}
            active={active}
            selectedKey={selectedKey}
            onSelectStep={onSelectStep}
          />
        )}
      </TabsContent>
      <TabsContent value="graph" className="pt-5">
        {graph === undefined ? (
          <GraphPlaceholder
            message={graphMessages[graphState]}
            loading={graphState === 'loading'}
          />
        ) : (
          <Suspense
            fallback={
              <GraphPlaceholder message={graphMessages.loading} loading />
            }
          >
            <RunGraphView
              graph={graph}
              rows={view.rows}
              selectedNodeId={selectedNodeId}
              onSelectNode={(nodeId) => {
                const row = view.rows.find(
                  (candidate) => candidate.nodeId === nodeId,
                );
                if (row !== undefined) onSelectStep(row.key);
              }}
            />
          </Suspense>
        )}
      </TabsContent>
      <TabsContent value="events" className="pt-4">
        <RunEventsView
          events={events}
          truncatedCount={truncatedCount}
          runStartMs={runStartMs}
          stepLabel={stepLabel}
          recoveryMessage={recoveryMessage}
          onViewOutput={onSelectStep}
        />
      </TabsContent>
      <TabsContent value="io" className="pt-5">
        <RunOutputsView
          rows={view.rows}
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
        />
      </TabsContent>
    </Tabs>
  );
}
