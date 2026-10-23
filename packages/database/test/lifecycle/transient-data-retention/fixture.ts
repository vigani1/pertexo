import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';

import { owner, randomUUID, workspaceId } from '../retention.support.js';

export const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export async function asOwner<Row extends QueryResultRow = QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
) {
  await owner.query('begin');
  try {
    await owner.query('set local role pertexo_owner');
    await owner.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const result = await owner.query<Row>(text, [...values]);
    await owner.query('commit');
    return result;
  } catch (error: unknown) {
    await owner.query('rollback').catch(() => undefined);
    throw error;
  }
}

export async function insertReplacement(
  id: string,
  next: string,
): Promise<void> {
  await asOwner(
    `insert into app.workspace_invitation_binding_replacement_claims
    (prior_workspace_id,prior_intent_id,prior_binding_digest,
     successor_workspace_id,successor_intent_id,successor_invitation_id,
     successor_invitation_revision,successor_binding_digest,successor_csrf_digest)
    values($1,$2,$3,$1,$4,$5,1,$6,$7)`,
    [
      workspaceId,
      id,
      digest(`binding:${id}`),
      next,
      randomUUID(),
      digest(`binding:${next}`),
      digest(`csrf:${next}`),
    ],
  );
}
