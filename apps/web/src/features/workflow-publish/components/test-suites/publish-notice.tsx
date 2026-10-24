import { QueryView } from '@/components/patterns/states/query-view';
import { useQuery } from '@tanstack/react-query';
import { Notice } from '@/components/ui/notice';
import type { WorkflowTestScope } from '../../data/workflow-tests/api';
import type { listSuites } from '../../data/test-suites/api';
import { suitesQueryOptions } from '../../data/test-suites/queries';

type SuiteList = Awaited<ReturnType<typeof listSuites>>;
export function SuitePublishNotice({
  scope,
  savedDraftCurrent,
  enabled,
  capabilities,
}: Readonly<{
  scope: WorkflowTestScope;
  savedDraftCurrent: boolean;
  enabled: boolean;
  capabilities: readonly string[];
}>) {
  const allowed =
    enabled &&
    ['workflow:update', 'run:read', 'run:start'].every((capability) =>
      capabilities.includes(capability),
    );
  const query = useQuery({ ...suitesQueryOptions(scope), enabled: allowed });
  if (!allowed) return null;
  return (
    <QueryView
      query={query}
      resource="The latest suite result"
      loading={
        <p className="text-xs text-muted-foreground" role="status">
          Checking latest test suite…
        </p>
      }
      error={() => (
        <Notice tone="warning">
          The latest suite result couldn’t be checked. You can still publish.
        </Notice>
      )}
    >
      {(suites) => (
        <LatestSuite suites={suites} savedDraftCurrent={savedDraftCurrent} />
      )}
    </QueryView>
  );
}

function LatestSuite({
  suites,
  savedDraftCurrent,
}: Readonly<{ suites: SuiteList; savedDraftCurrent: boolean }>) {
  const latest = suites.items.reduce<(typeof suites.items)[number] | undefined>(
    (best, item) =>
      best === undefined || item.createdAt > best.createdAt ? item : best,
    undefined,
  );
  if (latest === undefined)
    return <Notice>No suite has been run. You can still publish.</Notice>;
  const outdated =
    !savedDraftCurrent || latest.signature !== suites.current.signature;
  return (
    <Notice
      tone={outdated || latest.status !== 'passed' ? 'warning' : 'success'}
    >
      Latest suite: {latest.status} · {latest.passed}/{latest.total} passed.
      {outdated
        ? ' Out of date: the draft, pins, cases or variables changed.'
        : ''}
      {latest.status !== 'passed' || outdated
        ? ' Review the results; publishing is still available.'
        : ''}
    </Notice>
  );
}
