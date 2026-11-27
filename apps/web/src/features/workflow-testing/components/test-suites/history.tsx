import type { WorkflowTestSuiteDetail } from '@pertexo/contracts';
import { QueryView } from '@/components/patterns/states/query-view';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/patterns/notices/inline-notice';
import {
  Status,
  type StatusTone,
} from '@/components/patterns/status/status-mark';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { formatDate, formatClock } from '@/lib/format/time';
import type { TestSuites } from '../../data/test-suites/workflow-test-suites.mutations';
import { TestCaseReport } from './report';
const tones: Record<string, StatusTone> = {
  passed: 'success',
  failed: 'failure',
  error: 'failure',
  canceled: 'neutral',
  skipped: 'neutral',
  running: 'live',
  pending: 'queued',
};
export function TestSuiteHistory({
  suites,
  canCancelAny,
  onViewRun,
}: Readonly<{
  suites: TestSuites;
  canCancelAny: boolean;
  onViewRun: (runId: string) => void;
}>) {
  const detail = suites.detail.data;
  const choices = (suites.history.data?.items ?? []).map((stored) => {
    const item = detail?.suiteId === stored.suiteId ? detail : stored;
    return {
      value: item.suiteId,
      label: `${item.evaluation === undefined ? '' : 'Evaluation · '}${formatDate(item.createdAt)} ${formatClock(item.createdAt)} · ${item.status} · ${String(item.passed)}/${String(item.total)} cases passed`,
    };
  });
  return (
    <section aria-label="Test suites" className="space-y-3 border-t pt-3">
      <h3 className="text-sm font-medium">Suites</h3>
      <QueryView
        query={suites.history}
        resource="Suites"
        isEmpty={(history) => history.items.length === 0}
        empty={
          <p className="text-sm text-muted-foreground">
            No suite runs yet. Saved input cases form your suite.
          </p>
        }
      >
        {() => (
          <Select
            items={choices}
            value={suites.activeId ?? null}
            onValueChange={(value) => {
              if (value !== null) {
                suites.select(value);
              }
            }}
          >
            <SelectTrigger aria-label="Retained test suite">
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
        )}
      </QueryView>
      <QueryView query={suites.detail} resource="This suite" loading={null} />
      {detail === undefined ? null : (
        <SuiteResult
          key={detail.suiteId}
          detail={detail}
          suites={suites}
          canCancelAny={canCancelAny}
          onViewRun={onViewRun}
        />
      )}
      {suites.cancel.error === undefined ? null : (
        <Notice tone="destructive">
          {suites.cancel.error}
          {suites.cancel.uncertain ? (
            <Button
              disabled={suites.cancel.pending || suites.cancel.expired}
              onClick={suites.cancel.retry}
            >
              Retry same suite cancellation
            </Button>
          ) : null}
        </Notice>
      )}
    </section>
  );
}

function SuiteResult({
  detail,
  suites,
  canCancelAny,
  onViewRun,
}: Readonly<{
  detail: WorkflowTestSuiteDetail;
  suites: TestSuites;
  canCancelAny: boolean;
  onViewRun: (runId: string) => void;
}>) {
  const [reportOrdinal, setReportOrdinal] = useState<number>();
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Status tone={tones[detail.status] ?? 'neutral'}>
          {detail.evaluation === undefined ? 'Suite' : 'Evaluation'} ·{' '}
          {detail.status}
        </Status>
        <span className="text-xs text-muted-foreground">
          {detail.passed}/{detail.total} passed · {detail.failed} failed ·{' '}
          {detail.errors} errors · {detail.skipped} skipped
        </span>
        {detail.status === 'running' &&
        (canCancelAny || detail.startedBy === suites.scope.userId) ? (
          <Button
            size="sm"
            variant="outline"
            disabled={suites.cancel.pending}
            onClick={() => void suites.cancel.send(detail.suiteId)}
          >
            Cancel suite
          </Button>
        ) : null}
      </div>
      {detail.score === undefined ? null : (
        <p className="text-sm">
          <strong>
            {detail.score.matched}/{detail.score.total} assertions passed
          </strong>
          {' · '}
          {detail.score.failedRuns} failed runs
          {' · '}
          {detail.score.incompleteCases} incomplete cases
        </p>
      )}
      {detail.stopReason === null ? null : (
        <Notice tone="warning">
          Suite stopped: {detail.stopReason.replaceAll('_', ' ')}.
        </Notice>
      )}
      <ol className="divide-y">
        {detail.cases.map((entry) => {
          const name =
            detail.evaluation === undefined
              ? entry.name
              : `Row ${String(entry.ordinal + 1)}`;
          return (
            <li
              key={entry.ordinal}
              className="flex flex-wrap items-center gap-2 py-2"
            >
              <span className="min-w-0 flex-1 text-sm wrap-anywhere">
                {name}
              </span>
              <Status tone={tones[entry.status] ?? 'neutral'}>
                {detail.evaluation !== undefined &&
                (entry.status === 'error' || entry.status === 'skipped')
                  ? 'incomplete'
                  : entry.status}
              </Status>
              <div className="ml-auto flex flex-wrap gap-1">
                {entry.runId === null ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`View test ${name}`}
                    onClick={() => {
                      if (entry.runId !== null) onViewRun(entry.runId);
                    }}
                  >
                    View test
                  </Button>
                )}
                {['passed', 'failed', 'error'].includes(entry.status) ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Report ${name}`}
                    onClick={() => {
                      setReportOrdinal(
                        reportOrdinal === entry.ordinal
                          ? undefined
                          : entry.ordinal,
                      );
                    }}
                  >
                    Report
                  </Button>
                ) : null}
              </div>
              {reportOrdinal === entry.ordinal ? (
                <div className="w-full">
                  <TestCaseReport
                    key={`${detail.suiteId}:${String(entry.ordinal)}`}
                    scope={suites.scope}
                    suiteId={detail.suiteId}
                    ordinal={entry.ordinal}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </>
  );
}
