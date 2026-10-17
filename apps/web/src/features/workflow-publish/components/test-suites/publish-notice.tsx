import { useQuery } from '@tanstack/react-query';
import { Notice } from '@/components/ui/notice';
import type { WorkflowTestScope } from '../../data/workflow-tests/api';
import { suitesQueryOptions } from '../../data/test-suites/queries';
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
  if (query.isPending)
    return (
      <p className="text-xs text-muted-foreground" role="status">
        Checking latest test suite…
      </p>
    );
  if (query.isError)
    return (
      <Notice tone="warning">
        The latest suite result couldn’t be checked. You can still publish.
      </Notice>
    );
  const latest = query.data.items.reduce<
    (typeof query.data.items)[number] | undefined
  >(
    (best, item) =>
      best === undefined || item.createdAt > best.createdAt ? item : best,
    undefined,
  );
  if (latest === undefined)
    return <Notice>No suite has been run. You can still publish.</Notice>;
  const outdated =
    !savedDraftCurrent || latest.signature !== query.data.current.signature;
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
