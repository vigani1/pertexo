import { canonicalJson } from '@pertexo/workflow-model';
import { useQuery } from '@tanstack/react-query';
import { QueryView } from '@/components/patterns/states/query-view';
import { Notice } from '@/components/ui/notice';
import type { WorkflowTestScope } from '../../data/workflow-tests/api';
import type { getCaseReport } from '../../data/test-suites/api';
import { suiteReportQueryOptions } from '../../data/test-suites/queries';
export function TestCaseReport({
  scope,
  suiteId,
  ordinal,
}: Readonly<{ scope: WorkflowTestScope; suiteId: string; ordinal: number }>) {
  const query = useQuery(suiteReportQueryOptions(scope, suiteId, ordinal));
  return (
    <QueryView query={query} resource="This report">
      {(data) => <CaseReport found={data} />}
    </QueryView>
  );
}

type CaseReportResponse = Awaited<ReturnType<typeof getCaseReport>>;

function CaseReport({ found }: Readonly<{ found: CaseReportResponse }>) {
  const report = found.report;
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
              : `Step ${found.stepLabels[item.assertion.source.nodeId] ?? item.assertion.source.nodeId}`}{' '}
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
            {item.actual.preview ?? assertionFallback(item.actual)}
          </pre>
        </section>
      ))}
    </div>
  );
}

function assertionFallback(
  actual: NonNullable<
    CaseReportResponse['report']
  >['assertions'][number]['actual'],
): string | undefined {
  if (actual.state === 'value') return JSON.stringify(actual.value, null, 2);
  if (actual.state === 'ambiguous')
    return 'This step ran more than once. Assert its downstream summary instead.';
  return 'No value is available at this path.';
}
