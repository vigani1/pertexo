import { canonicalJson } from '@pertexo/workflow-model';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import type { WorkflowTestScope } from '../../data/workflow-tests/api';
import { suiteReportQueryOptions } from '../../data/test-suites/queries';
export function TestCaseReport({
  scope,
  suiteId,
  ordinal,
}: Readonly<{ scope: WorkflowTestScope; suiteId: string; ordinal: number }>) {
  const query = useQuery(suiteReportQueryOptions(scope, suiteId, ordinal));
  if (query.isPending)
    return <p role="status">Loading expected and actual values…</p>;
  if (query.isError)
    return (
      <Notice tone="destructive">
        This report couldn’t be loaded.{' '}
        <Button variant="ghost" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </Notice>
    );
  const report = query.data.report;
  if (report === null)
    return <p className="text-sm">No report is available for this case.</p>;
  return (
    <div className="min-w-0 space-y-3 text-sm">
      <p>
        Expected: {report.expectedOutcome}. Actual: {report.actualOutcome}.{' '}
        {report.outcomeMatched ? 'Outcome matches.' : 'Outcome differs.'}
      </p>
      {report.error === undefined ? null : (
        <Notice tone="warning">{report.error.replaceAll('_', ' ')}</Notice>
      )}
      {report.assertions.map((item) => (
        <section
          key={canonicalJson(item.assertion)}
          className="min-w-0 rounded-md border p-3"
        >
          <p>
            {item.actual.matched ? 'Passed' : 'Failed'} ·{' '}
            {item.assertion.source.kind === 'final'
              ? 'Final output'
              : `Step ${query.data.stepLabels[item.assertion.source.nodeId] ?? item.assertion.source.nodeId}`}{' '}
            · {item.assertion.path} · {item.assertion.operator}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">Expected</p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
            {JSON.stringify(item.assertion.expected, null, 2)}
          </pre>
          <p className="mt-2 text-xs text-muted-foreground">
            Actual · {item.actual.state}
            {item.actual.truncated
              ? ` · ${String(item.actual.bytes)} bytes, preview truncated`
              : ''}
          </p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
            {item.actual.preview ??
              (item.actual.state === 'value'
                ? JSON.stringify(item.actual.value, null, 2)
                : item.actual.state === 'ambiguous'
                  ? 'This step ran more than once. Assert its downstream summary instead.'
                  : 'No value is available at this path.')}
          </pre>
        </section>
      ))}
    </div>
  );
}
