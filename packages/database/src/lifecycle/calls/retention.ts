import { bindResourcePredicate } from '../../tenant-access/resources/query-scope.js';
import {
  RUN_DETAILS_RETENTION_SQL,
  RUN_SUMMARY_RETENTION_SQL,
} from '../../runs/data-policy.js';
/** Call payloads follow their parent's detail window; identity follows its summary. */
export const CALL_DETAILS_RETENTION_RULE = {
  name: 'call_details',
  statement: `
    with page as (
      select call.id from app.workflow_calls call
      join app.workflow_runs parent
        on parent.workspace_id = call.workspace_id and parent.id = call.parent_run_id
      where call.details_purged_at is null and call.consumed_at is not null
        and not call.slot_lent and call.status not in ('pending','accepted')
        and (call.cancel_requested_at is null or call.cancel_applied_at is not null)
        and parent.completed_at <= clock_timestamp() - ${bindResourcePredicate(RUN_DETAILS_RETENTION_SQL.inlineParams(), [])}
      order by parent.completed_at, call.id limit $1 for update of call skip locked
    )
    update app.workflow_calls call
    set input_ref = null, result_ref = null, details_purged_at = clock_timestamp()
    from page where call.id = page.id`,
} as const;

/** Detach an expired child's live FK while preserving its immutable outcome ID. */
export const CALL_CHILD_REFERENCES_RETENTION_RULE = {
  name: 'call_child_references',
  statement: `
    with page as (
      select child.workspace_id, child.id from app.workflow_runs child
      where child.completed_at <= clock_timestamp() - ${bindResourcePredicate(RUN_SUMMARY_RETENTION_SQL.inlineParams(), [])}
        and child.details_purged_at is not null
        and exists (select 1 from app.workflow_calls call
          where call.workspace_id = child.workspace_id and call.live_child_run_id = child.id
            and not call.slot_lent and call.status not in ('pending','accepted')
            and (call.cancel_requested_at is null or call.cancel_applied_at is not null))
        and not exists (select 1 from app.workflow_run_active_admissions admission
          where admission.workspace_id = child.workspace_id and admission.workflow_run_id = child.id)
      order by child.completed_at, child.id limit $1 for update of child skip locked
    )
    update app.workflow_calls call set live_child_run_id = null
    from page where call.workspace_id = page.workspace_id and call.live_child_run_id = page.id
      and not call.slot_lent and call.status not in ('pending','accepted')
      and (call.cancel_requested_at is null or call.cancel_applied_at is not null)`,
} as const;
