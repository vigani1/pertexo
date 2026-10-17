const unreferenced = `not exists (select 1 from app.workspace_variables head
  where head.workspace_id=revision.workspace_id and head.revision=revision.revision)
  and not exists (select 1 from app.workflow_runs run
    where run.workspace_id=revision.workspace_id and run.variable_set_revision=revision.revision)
  and not exists (select 1 from app.workflow_test_suites suite where suite.workspace_id=revision.workspace_id and suite.variable_set_revision=revision.revision)
  and not exists (select 1 from app.preview_runs preview
    where preview.workspace_id=revision.workspace_id and preview.variable_set_revision=revision.revision)`;

/** References, not age, own a set's lifetime; current configuration is always retained. */
export const VARIABLE_SET_RETENTION_RULE = {
  name: 'variable_sets',
  statement: `with page as (
    select revision.workspace_id,revision.revision
    from app.workspace_variable_set_revisions revision where ${unreferenced}
    order by revision.workspace_id,revision.revision limit $1 for update of revision skip locked
  ) delete from app.workspace_variable_set_revisions revision using page
    where revision.workspace_id=page.workspace_id and revision.revision=page.revision
      and ${unreferenced}`,
} as const;
