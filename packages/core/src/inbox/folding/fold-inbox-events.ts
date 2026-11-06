import type { PoolClient } from 'pg';
import { UNPURGED_WORKSPACE_STATUSES } from '@pertexo/policy';
import { withWorkspaceScope } from '@pertexo/database/primitives';
import { NOTICE_WINDOW_MILLIS } from '../lifetime.js';
import {
  claimFailures,
  consumeFailures,
  insertFailureThread,
  lockFailureThread,
  replaceFailureEpisode,
  type ClaimedFailure,
  type FailureEpisode,
} from './failure-fold.repository.js';
import type { WorkspaceInboxChange } from './workspace-inbox-change.types.js';

/** Queue locks, then workspace/workflow-ordered thread locks, all in one transaction. */
export async function foldInboxEvents(client: PoolClient, limit: number) {
  const claimed = await claimFailures(client, limit);
  const groups = new Map<string, ClaimedFailure[]>();
  for (const event of claimed.events) {
    const key = `${event.workspace_id}:${event.workflow_id}`;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  const changes = new Map<string, string>();
  for (const [, events] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const first = events[0];
    if (first === undefined) continue;
    const workspaceId = first.workspace_id;
    await withWorkspaceScope(client, { workspaceId }, async (scoped) => {
      if (
        UNPURGED_WORKSPACE_STATUSES.some(
          (status) => status === first.workspace_status,
        )
      ) {
        const scope = { workspaceId, workflowId: first.workflow_id };
        const incoming = groupEpisode(events);
        const inserted = await insertFailureThread(scoped, scope, incoming);
        const revision =
          inserted ??
          (await replaceFailureEpisode(
            scoped,
            scope,
            mergeEpisode(
              await lockFailureThread(scoped, scope),
              incoming,
              claimed.now,
            ),
          ));
        const previous = changes.get(workspaceId);
        if (previous === undefined || BigInt(previous) < BigInt(revision))
          changes.set(workspaceId, revision);
      }
      await consumeFailures(
        scoped,
        workspaceId,
        events.map((event) => event.id),
      );
    });
  }
  return Object.freeze(
    [...changes].map(([workspaceId, revision]): WorkspaceInboxChange =>
      Object.freeze({ workspaceId, revision }),
    ),
  );
}

function groupEpisode(events: readonly ClaimedFailure[]): FailureEpisode {
  // Fixed UTC timestamps retain all PostgreSQL fractional digits before the ID tie-break.
  const ordered = [...events].sort(
    (a, b) =>
      a.occurred_at.localeCompare(b.occurred_at) || a.id.localeCompare(b.id),
  );
  const first = ordered[0];
  const latest = ordered.at(-1);
  if (first === undefined || latest === undefined)
    throw new Error('Empty Inbox failure group');
  return {
    occurrenceCount: BigInt(events.length),
    firstOccurredAt: first.occurred_at,
    latestOccurredAt: latest.occurred_at,
    latestRunId: latest.run_id,
    latestKind: latest.kind,
  };
}

function mergeEpisode(
  prior: FailureEpisode,
  incoming: FailureEpisode,
  now: string,
): FailureEpisode {
  const expired =
    micros(prior.latestOccurredAt) <=
    micros(now) - BigInt(NOTICE_WINDOW_MILLIS) * 1000n;
  const latest =
    incoming.latestOccurredAt >= prior.latestOccurredAt ? incoming : prior;
  return {
    occurrenceCount: expired
      ? incoming.occurrenceCount
      : prior.occurrenceCount + incoming.occurrenceCount,
    firstOccurredAt:
      expired || incoming.firstOccurredAt < prior.firstOccurredAt
        ? incoming.firstOccurredAt
        : prior.firstOccurredAt,
    latestOccurredAt: latest.latestOccurredAt,
    latestRunId: latest.latestRunId,
    latestKind: latest.latestKind,
  };
}

function micros(timestamp: string): bigint {
  return (
    BigInt(Date.parse(timestamp)) * 1000n + BigInt(timestamp.slice(23, 26))
  );
}
