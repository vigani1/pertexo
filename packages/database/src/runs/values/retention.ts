import { bindResourcePredicate } from '../../tenant-access/resources/query-scope.js';
import { expiredRunSql } from '../data-policy.js';

export const RUN_VALUES_RETENTION_RULE = Object.freeze({
  name: 'workflow_run_values',
  statement: `with page as (
    select value.workspace_id,value.id from app.workflow_run_values value
    join app.workflow_runs run on run.workspace_id=value.workspace_id and run.id=value.workflow_run_id
    where ${bindResourcePredicate(expiredRunSql('run').inlineParams(), [])}
    order by value.id limit $1 for update of value skip locked
  ) delete from app.workflow_run_values value using page where value.workspace_id=page.workspace_id and value.id=page.id`,
});
