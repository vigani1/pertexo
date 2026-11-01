import { TestSuiteHistory } from '../test-suites/history';
import { QueryView } from '@/components/patterns/states/query-view';
import { TestSuiteDialog } from '../test-suites/dialog';
import { XIcon } from 'lucide-react';
import { WorkflowTestResults } from './results';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { formatDate, formatClock } from '@/lib/format/time';
import { Button } from '@/components/ui/button';
import { Status } from '@/components/ui/status';
import { Notice } from '@/components/ui/notice';
import {
  describeRunStatus,
  isActiveRunStatus,
} from '@/features/workflow-runs/labels.public';
import { useRunEvents } from '@/features/workflow-runs/queries.public';
import type { WorkflowTests } from '../../hooks/use-workflow-tests';

/**
 * The tests dock below the canvas. It shows only for test activity: a test or
 * suite started here, history asked for from the Test workflow menu, a test
 * still running, or a problem to report. Run all tests lives in that menu.
 */
export const WORKFLOW_TEST_HISTORY_ID = 'workflow-test-history';

export function WorkflowTestHistory({
  tests,
  ensureSaved,
  currentRevision,
  canCancelAny,
}: Readonly<{
  tests: WorkflowTests;
  ensureSaved: () => Promise<{ revision: number }>;
  currentRevision: number;
  canCancelAny: boolean;
}>) {
  if (!tests.enabled) return null;
  const progress = tests.progress.data;
  const running =
    progress !== undefined && isActiveRunStatus(progress.run.status);
  const problem =
    tests.cancel.error !== undefined ||
    tests.history.isError ||
    tests.progress.isError ||
    tests.snapshot.isError;
  const expanded = tests.panel === 'history';
  return (
    <>
      {/* Outside the bar: Run all tests opens it from the menu. */}
      <TestSuiteDialog key={String(tests.suites.open)} suites={tests.suites} />
      {tests.panel === 'hidden' && !running && !problem ? null : (
        <section
          id={WORKFLOW_TEST_HISTORY_ID}
          tabIndex={-1}
          aria-label="Workflow tests"
          className={`lens pointer-events-auto flex min-h-0 flex-col gap-2 overflow-hidden rounded-t-xl p-3 ${expanded ? 'h-[30svh]' : 'max-h-[30svh] min-h-16'}`}
        >
          <WorkflowTestRunControls
            tests={tests}
            expanded={expanded}
            running={running}
            onToggle={() => {
              if (expanded) tests.showSummary();
              else tests.showHistory();
            }}
            currentRevision={currentRevision}
            canCancelAny={canCancelAny}
          />
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tests.cancel.error === undefined ? null : (
              <Notice tone="destructive">
                {tests.cancel.error}
                {tests.cancel.uncertain ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={tests.cancel.retry}
                  >
                    Retry same cancellation
                  </Button>
                ) : null}
              </Notice>
            )}
            <QueryView
              query={tests.history}
              resource="Test history"
              loading={null}
            />
            <QueryView
              query={tests.progress}
              resource="This test"
              loading={null}
            />
            <QueryView
              query={tests.snapshot}
              resource="This test"
              loading={null}
            />
            {expanded ? (
              <TestHistoryContents
                tests={tests}
                ensureSaved={ensureSaved}
                canCancelAny={canCancelAny}
              />
            ) : null}
          </div>
        </section>
      )}
    </>
  );
}
function TestHistoryContents({
  tests,
  ensureSaved,
  canCancelAny,
}: Readonly<{
  tests: WorkflowTests;
  ensureSaved: () => Promise<{ revision: number }>;
  canCancelAny: boolean;
}>) {
  return (
    <div className="mt-3 flex flex-col gap-3">
      {tests.history.data?.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No workflow tests yet.</p>
      ) : null}
      <WorkflowTestPicker tests={tests} />
      <WorkflowTestResults tests={tests} ensureSaved={ensureSaved} />
      <TestSuiteHistory
        suites={tests.suites}
        canCancelAny={canCancelAny}
        onViewRun={tests.selectRun}
      />
    </div>
  );
}

function WorkflowTestRunControls({
  tests,
  expanded,
  running,
  onToggle,
  currentRevision,
  canCancelAny,
}: Readonly<{
  tests: WorkflowTests;
  expanded: boolean;
  running: boolean;
  onToggle: () => void;
  currentRevision: number;
  canCancelAny: boolean;
}>) {
  const snapshot = tests.snapshot.data;
  const progress = tests.progress.data;
  const look =
    progress === undefined
      ? undefined
      : describeRunStatus({ status: progress.run.status });
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5 sm:gap-3">
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
          {expanded ? 'Hide history' : 'Test history'}
        </Button>
        {(canCancelAny || snapshot?.startedBy === tests.scope.userId) &&
        running &&
        tests.activeId !== undefined ? (
          <Button
            size="sm"
            variant="outline"
            disabled={tests.cancel.pending}
            onClick={() => void tests.cancel.send(tests.activeId ?? '')}
          >
            Cancel test
          </Button>
        ) : null}
        {running ? null : (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Close tests"
            onClick={tests.hidePanel}
          >
            <XIcon />
          </Button>
        )}
      </div>
      {tests.activeId === undefined || !running ? null : (
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

function WorkflowTestPicker({
  tests,
}: Readonly<{
  tests: Pick<
    WorkflowTests,
    'history' | 'snapshot' | 'progress' | 'activeId' | 'selectRun'
  >;
}>) {
  const progress = tests.progress.data;
  const retained = tests.history.data?.items ?? [];
  const selected = tests.snapshot.data;
  const items =
    selected !== undefined &&
    !retained.some((item) => item.runId === selected.runId)
      ? [selected, ...retained]
      : retained;
  const choices = items.map((item) => ({
    value: item.runId,
    label: `Draft ${String(item.draftRevision)} · ${describeRunStatus({ status: item.runId === progress?.run.id ? progress.run.status : item.status }).label} · ${formatDate(item.createdAt)} · ${formatClock(item.createdAt)}`,
  }));
  if (choices.length === 0) return null;
  return (
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
  );
}
