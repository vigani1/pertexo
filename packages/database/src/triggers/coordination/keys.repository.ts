import { sql } from 'drizzle-orm';
import {
  EVENT_COORDINATION_LIMITS,
  type EventCoordinationPolicy,
  type EventCoordinationWindow,
} from '@pertexo/workflow-model';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import type { CoordinateEventInput } from './contract.js';
export type EventWindowRow = Readonly<{
  id: string;
  window_started_at: Date;
  used_count: number;
  expires_at: Date;
}>;
export async function eventDatabaseTime(
  transaction: WorkspaceTransaction,
): Promise<Date> {
  const result = await transaction.db.execute<{ now: string }>(
    sql`select clock_timestamp() now`,
  );
  const at = result.rows[0]?.now;
  if (at === undefined) throw new Error('Event coordination clock unavailable');
  return new Date(at);
}
export async function loadEventWindow(
  transaction: WorkspaceTransaction,
  input: CoordinateEventInput,
  now: Date,
): Promise<EventWindowRow | undefined> {
  const row = (
    await transaction.db.execute<
      Omit<EventWindowRow, 'window_started_at' | 'expires_at'> & {
        window_started_at: string;
        expires_at: string;
      }
    >(sql`
    select id,window_started_at,used_count,expires_at from app.trigger_event_windows where workspace_id=${transaction.workspaceId} and workflow_id=${input.workflowId} and node_id=${input.nodeId} and policy_hash=${input.prepared.policyHash} and key_hash=${input.prepared.keyHash} for update
  `)
  ).rows[0];
  const found =
    row === undefined
      ? undefined
      : {
          ...row,
          window_started_at: new Date(row.window_started_at),
          expires_at: new Date(row.expires_at),
        };
  const pending =
    found === undefined
      ? false
      : (
          await transaction.db.execute(
            sql`select 1 from app.trigger_coordinated_events where workspace_id=${transaction.workspaceId} and key_id=${found.id} and status='pending' limit 1`,
          )
        ).rows.length > 0;
  const hasLiveKey = found !== undefined && (found.expires_at > now || pending);
  if (hasLiveKey) return found;
  const count =
    (
      await transaction.db.execute<{ count: number }>(sql`
    select count(*)::integer count from app.trigger_event_windows state where workspace_id=${transaction.workspaceId} and (expires_at>${now} or exists(select 1 from app.trigger_coordinated_events event where event.workspace_id=state.workspace_id and event.key_id=state.id and event.status='pending'))
  `)
    ).rows[0]?.count ?? 0;
  if (count >= EVENT_COORDINATION_LIMITS.activeKeys) return undefined;
  if (found !== undefined) return found;
  const id = generatePersistedId();
  const policy = input.prepared.policy;
  const seconds =
    policy.mode === 'debounce' ? policy.quietSeconds : policy.windowSeconds;
  await transaction.db.execute(
    sql`insert into app.trigger_event_windows(id,workspace_id,workflow_id,node_id,policy_hash,key_hash,window_started_at,used_count,expires_at) values(${id},${transaction.workspaceId},${input.workflowId},${input.nodeId},${input.prepared.policyHash},${input.prepared.keyHash},${now},0,${new Date(now.getTime() + seconds * 1_000)})`,
  );
  return {
    id,
    window_started_at: now,
    used_count: 0,
    expires_at: new Date(now.getTime() + seconds * 1_000),
  };
}
export async function chargeEventWindow(
  transaction: WorkspaceTransaction,
  keyId: string,
  policy: EventCoordinationPolicy,
  window: EventCoordinationWindow,
): Promise<void> {
  const seconds =
    policy.mode === 'debounce' ? policy.quietSeconds : policy.windowSeconds;
  await transaction.db.execute(
    sql`update app.trigger_event_windows set window_started_at=${new Date(window.startedAt)},used_count=${window.used + 1},expires_at=${new Date(window.startedAt + seconds * 1_000)} where workspace_id=${transaction.workspaceId} and id=${keyId}`,
  );
}

/** Serialize first-key creation and workspace budgets before any workflow/state locks. */
export async function lockEventCoordination(
  workspaceId: string,
  db: Pick<WorkspaceTransaction['db'], 'execute'>,
) {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`pertexo.trigger-coordination:${workspaceId}`}, 81472591))`,
  );
}
