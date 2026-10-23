import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { AuditFilter, AuditEvent } from '@pertexo/contracts';
import { GovernanceError } from '../contract.js';
import { projectAuditMetadata } from './projection.js';
const cursorSchema = z
  .object({ time: z.iso.datetime(), id: z.uuid() })
  .strict();
export type AuditCursor = z.output<typeof cursorSchema>;
export function decodeAuditCursor(
  encoded: string | undefined,
): AuditCursor | undefined {
  if (encoded === undefined) return undefined;
  try {
    return cursorSchema.parse(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
    );
  } catch {
    throw new GovernanceError(
      'invalid',
      'The audit cursor is invalid. Reload the audit log.',
    );
  }
}
export type AuditRow = Readonly<{
  id: string;
  actor_user_id: string | null;
  actor_name: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  occurred_at: Date;
  cursor_time: string;
  metadata: unknown;
}>;
export function encodeAuditCursor(row: AuditRow): string {
  return Buffer.from(
    JSON.stringify({ time: row.cursor_time, id: row.id }),
  ).toString('base64url');
}
export function projectAuditEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    actorId: row.actor_user_id,
    actorName: row.actor_name,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    occurredAt: row.occurred_at.toISOString(),
    metadata: projectAuditMetadata(row.metadata),
  };
}
function auditWhere(
  workspaceId: string,
  query: AuditFilter,
  after?: AuditCursor,
  upper?: AuditCursor,
) {
  const parameters: unknown[] = [workspaceId];
  const predicates = ['audit.workspace_id=$1'];
  function filter(sql: string, value: unknown) {
    parameters.push(value);
    predicates.push(sql.replace('?', `$${String(parameters.length)}`));
  }
  if (query.person !== undefined)
    filter(
      'exists (select 1 from app.users person where person.id=audit.actor_user_id and strpos(lower(person.display_name),lower(?))>0)',
      query.person,
    );
  if (query.actorId !== undefined)
    filter('audit.actor_user_id=?::uuid', query.actorId);
  if (query.action !== undefined) filter('audit.action=?', query.action);
  if (query.targetType !== undefined)
    filter('audit.target_type=?', query.targetType);
  if (query.targetId !== undefined)
    filter('audit.target_id=?::uuid', query.targetId);
  if (query.from !== undefined)
    filter('audit.occurred_at>=?::timestamptz', query.from);
  if (query.until !== undefined)
    filter('audit.occurred_at<?::timestamptz', query.until);
  for (const [cursor, operator] of [
    [after, '<'],
    [upper, '<='],
  ] as const) {
    if (cursor === undefined) continue;
    parameters.push(cursor.time, cursor.id);
    predicates.push(
      `(audit.occurred_at,audit.id) ${operator} ($${String(parameters.length - 1)}::timestamptz,$${String(parameters.length)}::uuid)`,
    );
  }
  return { parameters, where: predicates.join(' and ') };
}
export async function readAuditBatch(
  client: PoolClient,
  workspaceId: string,
  {
    query,
    limit,
    after,
    upper,
  }: Readonly<{
    query: AuditFilter;
    limit: number;
    after?: AuditCursor | undefined;
    upper?: AuditCursor | undefined;
  }>,
): Promise<AuditRow[]> {
  const { parameters, where } = auditWhere(workspaceId, query, after, upper);
  parameters.push(limit);
  return (
    await client.query<AuditRow>(
      `select audit.id,audit.actor_user_id,actor.display_name actor_name,audit.action,audit.target_type,audit.target_id,audit.occurred_at,to_char(audit.occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_time,audit.metadata from app.audit_events audit left join app.users actor on actor.id=audit.actor_user_id where ${where} order by audit.occurred_at desc,audit.id desc limit $${String(parameters.length)}`,
      parameters,
    )
  ).rows;
}
export async function countAuditExport(
  client: PoolClient,
  workspaceId: string,
  query: AuditFilter,
): Promise<number> {
  const { parameters, where } = auditWhere(workspaceId, query);
  return Number(
    (
      await client.query<{ count: string }>(
        `select count(*) from (select 1 from app.audit_events audit where ${where} limit 100001) bounded`,
        parameters,
      )
    ).rows[0]?.count ?? 0,
  );
}
