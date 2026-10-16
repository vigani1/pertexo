import { WorkflowTestResults } from './results';
import { WorkflowTestButton } from './controls';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { formatDate, formatClock } from '@/lib/format/time';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Status } from '@/components/ui/status';
import { Notice } from '@/components/ui/notice';
import {
  describeRunStatus,
  isActiveRunStatus,
} from '@/features/workflow-runs/run-labels.public';
import { useRunEvents } from '@/features/workflow-runs/queries.public';
import type { WorkflowTests } from '../../hooks/use-workflow-tests';

export function WorkflowTestHistory({
  tests,
  ensureSaved,
  currentRevision,
  canCancel,
}: Readonly<{
  tests: WorkflowTests;
  ensureSaved: () => Promise<{ revision: number }>;
  currentRevision: number;
  canCancel: boolean;
}>) {
  const [expanded, setExpanded] = useState(false);
  if (!tests.enabled) return null;
  const progress = tests.progress.data;
  const choices = (tests.history.data?.items ?? []).map((item) => ({
    value: item.runId,
    label: `Draft ${String(item.draftRevision)} · ${describeRunStatus(item.runId === progress?.run.id ? progress.run.status : item.status).label} · ${formatDate(item.createdAt)} · ${formatClock(item.createdAt)}`,
  }));
  return (
    <section
      aria-label="Workflow tests"
      className="lens pointer-events-auto max-h-[40svh] overflow-y-auto rounded-xl p-3"
    >
      <WorkflowTestRunControls
        tests={tests}
        expanded={expanded}
        onToggle={() => {
          setExpanded(!expanded);
        }}
        currentRevision={currentRevision}
        canCancel={canCancel}
      />
      {tests.cancel.error === undefined ? null : (
        <Notice tone="destructive">
          {tests.cancel.error}
          {tests.cancel.uncertain ? (
            <Button size="sm" variant="ghost" onClick={tests.cancel.retry}>
              Retry same cancellation
            </Button>
          ) : null}
        </Notice>
      )}
      {tests.history.isError ? (
        <p role="alert">
          Test history couldn’t be loaded.{' '}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void tests.history.refetch()}
          >
            Retry
          </Button>
        </p>
      ) : null}
      {tests.progress.isError || tests.snapshot.isError ? (
        <p role="alert">
          This test couldn’t be read.{' '}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void tests.progress.refetch();
              void tests.snapshot.refetch();
            }}
          >
            Retry
          </Button>
        </p>
      ) : null}
      {expanded ? (
        <div className="mt-3 flex flex-col gap-3">
          {tests.history.data?.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No workflow tests yet.
            </p>
          ) : null}
          {choices.length > 0 ? (
            <Select
              items={choices}
              value={tests.activeId ?? null}
              onValueChange={(value) => {
                if (value !== null) tests.selectRun(value);
              }}
            >
              <SelectTrigger
                aria-label="Retained workflow test"
                className="w-full sm:max-w-lg"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choices.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <WorkflowTestResults tests={tests} ensureSaved={ensureSaved} />
        </div>
      ) : null}
    </section>
  );
}
function WorkflowTestRunControls({
  tests,
  expanded,
  onToggle,
  currentRevision,
  canCancel,
}: Readonly<{
  tests: WorkflowTests;
  expanded: boolean;
  onToggle: () => void;
  currentRevision: number;
  canCancel: boolean;
}>) {
  const snapshot = tests.snapshot.data;
  const progress = tests.progress.data;
  const active =
    progress !== undefined && isActiveRunStatus(progress.run.status);
  const look =
    progress === undefined ? undefined : describeRunStatus(progress.run.status);
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <WorkflowTestButton tests={tests} className="sm:hidden" />
        {look === undefined ? (
          <span className="text-sm font-medium">Workflow tests</span>
        ) : (
          <Status tone={look.tone}>Test · {look.label}</Status>
        )}
        {snapshot === undefined ? null : (
          <span className="text-xs text-muted-foreground">
            Draft {snapshot.draftRevision}
            {snapshot.draftRevision === currentRevision
              ? ''
              : ' · Earlier draft'}
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => {
            onToggle();
          }}
        >
          {expanded ? 'Hide tests' : 'Test history'}
        </Button>
        {canCancel && active && tests.activeId !== undefined ? (
          <Button
            size="sm"
            variant="outline"
            disabled={tests.cancel.pending}
            onClick={() => void tests.cancel.send(tests.activeId ?? '')}
          >
            Cancel test
          </Button>
        ) : null}
      </div>
      {tests.activeId === undefined || !active ? null : (
        <TestStream key={tests.activeId} tests={tests} runId={tests.activeId} />
      )}
    </>
  );
}
function TestStream({
  tests,
  runId,
}: Readonly<{ tests: WorkflowTests; runId: string }>) {
  const events = useRunEvents(
    tests.scope.apiClient,
    tests.scope.userId,
    tests.scope.workspaceId,
    runId,
  );
  return (
    <p className="mt-1 text-xs text-muted-foreground" role="status">
      {events.connectionStatus === 'live'
        ? 'Live step progress'
        : (events.recoveryMessage ?? 'Connecting to live step progress…')}
    </p>
  );
}
