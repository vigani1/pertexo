import type { WorkspaceVariableValues } from '@pertexo/workflow-model';

import { queryAsOwner } from './workflow-authoring/queries.js';

/**
 * Puts a workspace's variable set in place as rows, for tests whose subject only
 * reads it. The settings flow lives in core, which this package can't import.
 */
export async function setVariableSet(
  workspaceId: string,
  values: WorkspaceVariableValues,
): Promise<void> {
  await queryAsOwner(
    `with next_set as (
       insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json)
       select $1,coalesce(max(revision),0)+1,$2::jsonb
         from app.workspace_variable_set_revisions where workspace_id=$1
       returning revision
     )
     insert into app.workspace_variables(workspace_id,revision)
     select $1,revision from next_set
     on conflict (workspace_id) do update set revision=excluded.revision`,
    [workspaceId, JSON.stringify(values)],
    workspaceId,
  );
}

export async function readVariableSet(
  workspaceId: string,
): Promise<WorkspaceVariableValues> {
  const [row] = await queryAsOwner<{ values: WorkspaceVariableValues }>(
    `select variable_set.values_json as values
       from app.workspace_variables head
       join app.workspace_variable_set_revisions variable_set
         on variable_set.workspace_id=head.workspace_id and variable_set.revision=head.revision
      where head.workspace_id=$1`,
    [workspaceId],
    workspaceId,
  );
  return row?.values ?? {};
}
