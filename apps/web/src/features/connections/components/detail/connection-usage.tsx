import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { LoadMore } from '@/components/patterns/lists/load-more';
import { QueryView } from '@/components/patterns/states/query-view';
import { SkeletonRows } from '@/components/patterns/states/loading';
import { useStepDescriptions } from '@/features/catalog/public';
import type { ConnectionMutationScope } from '../../data/connections.mutations';
import { connectionUsageQueryOptions } from '../../data/connections.queries';
import type { ConnectionUsageResponse } from '@pertexo/contracts';
import { pluralWord } from '@/lib/format/count';
import { useState } from 'react';
import { Row, RowList } from '@/components/patterns/lists/row';
import { RuleHeading } from '@/components/patterns/lists/rule-heading';
import { SearchInput } from '@/components/ui/input';

/** How many workflows the thread drawing shows before "and N more". */
const THREADED_WORKFLOWS = 5;

/** Retained published versions, not drafts or an inferred current graph. */
export function ConnectionUsage({
  scope,
  connectionId,
  connectionName,
  canRead,
}: Readonly<{
  scope: ConnectionMutationScope;
  connectionId: string;
  connectionName: string;
  canRead: boolean;
}>) {
  const usage = useInfiniteQuery({
    ...connectionUsageQueryOptions(
      scope.apiClient,
      scope.userId,
      scope.workspaceId,
      connectionId,
    ),
    enabled: canRead,
  });
  const workflows = usedByWorkflow(
    usage.data?.pages.flatMap((page) => page.items) ?? [],
  );
  return (
    <section aria-labelledby="used-by" className="flex flex-col gap-2">
      <RuleHeading
        id="used-by"
        appearance="compact"
        {...(workflows.length === 0 ? {} : { count: workflows.length })}
      >
        Used by
      </RuleHeading>
      <p className="text-meta text-subtle-foreground">
        Published versions that use it, including older ones runs still rely on.
        Drafts aren’t counted.
      </p>
      {!canRead ? (
        <p className="text-sm text-muted-foreground">
          Workflow-read permission is needed to see usage.
        </p>
      ) : (
        <>
          <QueryView
            query={usage}
            resource="Connection usage"
            loading={<SkeletonRows label="Loading connection usage" />}
            isEmpty={(data) =>
              data.pages.every((page) => page.items.length === 0)
            }
            empty={
              <p className="text-sm text-muted-foreground">
                No retained published versions use this connection.
              </p>
            }
          >
            {() => (
              <>
                <UsageThreads
                  workspaceId={scope.workspaceId}
                  connectionName={connectionName}
                  workflows={workflows}
                />
                {workflows.length > THREADED_WORKFLOWS ? (
                  <AllWorkflows
                    workspaceId={scope.workspaceId}
                    connectionName={connectionName}
                    workflows={workflows}
                    complete={!usage.hasNextPage}
                  />
                ) : null}
              </>
            )}
          </QueryView>
          <LoadMore
            subject="published versions"
            hasNextPage={usage.hasNextPage}
            loading={usage.isFetchingNextPage}
            failed={usage.isFetchNextPageError}
            error={usage.error}
            onLoadMore={() => void usage.fetchNextPage()}
          />
        </>
      )}
    </section>
  );
}

/** Row height of a threaded workflow, in px, shared by the rows and the drawing. */
const THREAD_ROW = 56;

/**
 * Threads from this connection to the first workflows that use it. Only the
 * chosen connection draws them, so the page never fills with lines.
 */
function UsageThreads({
  workspaceId,
  connectionName,
  workflows,
}: Readonly<{
  workspaceId: string;
  connectionName: string;
  workflows: readonly WorkflowUsage[];
}>) {
  const shown = workflows.slice(0, THREADED_WORKFLOWS);
  const more = workflows.length - shown.length;
  const ends = shown.length + (more > 0 ? 1 : 0);
  const height = ends * THREAD_ROW;
  const middle = height / 2;
  return (
    <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-x-3 sm:grid-cols-[12.75rem_minmax(0,1fr)]">
      <div
        aria-hidden="true"
        className="relative max-sm:hidden"
        style={{ height }}
      >
        <svg
          width="204"
          height={height}
          viewBox={`0 0 204 ${String(height)}`}
          className="absolute inset-0 overflow-visible"
        >
          {Array.from({ length: ends }, (_, index) => {
            const y = index * THREAD_ROW + THREAD_ROW / 2;
            const last = more > 0 && index === ends - 1;
            return (
              <g key={y}>
                <path
                  d={`M115 ${String(middle)} C 160 ${String(middle)}, 160 ${String(y)}, 196 ${String(y)}`}
                  fill="none"
                  className={last ? 'stroke-border' : 'stroke-border-strong'}
                  strokeWidth="1.2"
                  strokeDasharray={last ? '3 4' : undefined}
                />
                <circle
                  cx="200"
                  cy={y}
                  r="2.8"
                  className={
                    last
                      ? 'fill-none stroke-subtle-foreground'
                      : 'fill-muted-foreground'
                  }
                />
              </g>
            );
          })}
          <circle
            cx="110"
            cy={middle}
            r="10"
            className="fill-none stroke-border-strong"
          />
          <circle
            cx="110"
            cy={middle}
            r="5"
            className="fill-muted-foreground"
          />
        </svg>
        <span
          className="absolute right-26 left-0 -translate-y-1/2 truncate text-right text-sm font-semibold"
          style={{ top: middle }}
        >
          {connectionName}
        </span>
      </div>
      <ul aria-label="Workflows using it" className="flex min-w-0 flex-col">
        {shown.map((workflow) => (
          <li
            key={workflow.workflowId}
            className="flex h-14 min-w-0 flex-col justify-center"
          >
            <WorkflowLink workspaceId={workspaceId} workflow={workflow} />
          </li>
        ))}
        {more > 0 ? (
          <li className="flex h-14 items-center">
            <a
              href="#all-workflows"
              className="text-sm text-muted-foreground hover:text-foreground focus-ring"
            >
              and {String(more)} more {pluralWord(more, 'workflow')}
            </a>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function WorkflowLink({
  workspaceId,
  workflow,
}: Readonly<{ workspaceId: string; workflow: WorkflowUsage }>) {
  const describeStep = useStepDescriptions();
  return (
    <>
      <Link
        to="/w/$workspaceId/workflows/$workflowId"
        params={{ workspaceId, workflowId: workflow.workflowId }}
        className="block truncate rounded-sm text-sm font-semibold hover:underline focus-ring"
      >
        {workflow.workflowName}
      </Link>
      <span className="block truncate font-mono text-caption text-subtle-foreground">
        {workflow.operationKeys
          .map((key) => describeStep(key).name)
          .join(' · ')}
        {' · '}
        {describeVersions(workflow)}
      </span>
    </>
  );
}

/** Loaded usage, searchable by workflow or step name. */
function AllWorkflows({
  workspaceId,
  connectionName,
  workflows,
  complete,
}: Readonly<{
  workspaceId: string;
  connectionName: string;
  workflows: readonly WorkflowUsage[];
  complete: boolean;
}>) {
  const describeStep = useStepDescriptions();
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const matching = workflows.filter(
    (workflow) =>
      needle === '' ||
      workflow.workflowName.toLocaleLowerCase().includes(needle) ||
      workflow.operationKeys.some((key) =>
        describeStep(key).name.toLocaleLowerCase().includes(needle),
      ),
  );
  const heading = complete
    ? `All ${String(workflows.length)} workflows`
    : `${String(workflows.length)} workflows loaded`;
  return (
    <section
      id="all-workflows"
      aria-labelledby="all-workflows-heading"
      className="mt-8 flex flex-col gap-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3
          id="all-workflows-heading"
          className="font-heading text-section font-semibold"
        >
          {heading}
        </h3>
        <SearchInput
          className="w-full sm:w-70"
          placeholder="Find a workflow or step"
          aria-label={`Find a workflow or step that uses ${connectionName}`}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </div>
      {matching.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">
          No {complete ? '' : 'loaded '}workflow or step matches “{query.trim()}
          ”.
          {complete
            ? null
            : ' Load more published versions to continue searching.'}
        </p>
      ) : (
        <RowList aria-label={`${heading} using ${connectionName}`}>
          {matching.map((workflow) => (
            <Row
              key={workflow.workflowId}
              className="grid-cols-[minmax(0,1fr)]"
            >
              <span className="min-w-0">
                <WorkflowLink workspaceId={workspaceId} workflow={workflow} />
              </span>
            </Row>
          ))}
        </RowList>
      )}
    </section>
  );
}

type UsageItem = ConnectionUsageResponse['items'][number];
type WorkflowUsage = Readonly<{
  workflowId: string;
  workflowName: string;
  archived: boolean;
  current: number | undefined;
  older: number;
  operationKeys: readonly string[];
}>;

/** Runs keep older versions alive, so one workflow can appear many times; show it once. */
function usedByWorkflow(items: readonly UsageItem[]): readonly WorkflowUsage[] {
  const workflows = new Map<string, WorkflowUsage>();
  for (const item of items) {
    const known = workflows.get(item.workflowId);
    workflows.set(item.workflowId, {
      workflowId: item.workflowId,
      workflowName: item.workflowName,
      archived: item.workflowLifecycleStatus === 'archived',
      current: item.isCurrentPublication ? item.versionNumber : known?.current,
      older: (known?.older ?? 0) + (item.isCurrentPublication ? 0 : 1),
      operationKeys: [
        ...new Set([...(known?.operationKeys ?? []), ...item.operationKeys]),
      ],
    });
  }
  return [...workflows.values()];
}

function describeVersions(workflow: WorkflowUsage): string {
  const older =
    workflow.older === 0
      ? ''
      : `${String(workflow.older)} older ${pluralWord(workflow.older, 'version')} still used by runs`;
  const live =
    workflow.current === undefined
      ? ''
      : `Live as version ${String(workflow.current)}`;
  const parts = [live, older].filter((part) => part !== '');
  return `${parts.join(', ')}${workflow.archived ? ' (archived workflow)' : ''}`;
}
