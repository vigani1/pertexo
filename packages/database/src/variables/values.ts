import type { PoolClient } from 'pg';
import {
  EMPTY_VARIABLE_SNAPSHOT,
  workspaceVariableValuesSchema,
} from '@pertexo/workflow-model';

/** Null references mean the fixed empty set; a missing positive reference must fail decoding. */
export function variableSetValuesSql(owner: 'run' | 'preview'): string {
  return `case when ${owner}.variable_set_revision is null then '{}'::jsonb else variable_set.values_json end`;
}
export function variableSetSnapshotSql(owner: 'run' | 'preview'): string {
  return `jsonb_build_object('revision',coalesce(${owner}.variable_set_revision,0),'values',${variableSetValuesSql(owner)})`;
}
/** Callable completion reads values lazily, rather than on every coordinator advance. */
export async function readVariableSetValues(
  client: PoolClient,
  workspaceId: string,
  revision: number | null,
) {
  if (revision === null) return EMPTY_VARIABLE_SNAPSHOT.values;
  const result = await client.query<{ values_json: unknown }>(
    'select values_json from app.workspace_variable_set_revisions where workspace_id=$1 and revision=$2',
    [workspaceId, revision],
  );
  return workspaceVariableValuesSchema.parse(result.rows[0]?.values_json);
}
