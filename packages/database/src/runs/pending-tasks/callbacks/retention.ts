import { bindResourcePredicate } from '../../../tenant-access/resources/query-scope.js';
import { expiredRunSql } from '../../data-policy.js';
/** Bound tasks already cascade with node details; prepared tasks have no node. */
export const CALLBACK_TASK_RETENTION_RULE = {
  name: 'prepared_callbacks',
  statement: `with page as (
    select task.id from app.pending_run_tasks task
    join app.workflow_runs run on run.workspace_id=task.workspace_id and run.id=task.run_id
    where task.kind='callback' and task.node_run_id is null and ${bindResourcePredicate(expiredRunSql('run').inlineParams(), [])}
    order by task.id limit $1 for update of task skip locked
  ) delete from app.pending_run_tasks task using page where task.id=page.id`,
} as const;
