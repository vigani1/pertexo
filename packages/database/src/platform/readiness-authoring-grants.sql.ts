export const READINESS_AUTHORING_GRANTS_SQL = `
      (
        (select relrowsecurity and relforcerowsecurity from pg_class where oid = to_regclass('app.workflows'))
        and (select relrowsecurity and relforcerowsecurity from pg_class where oid = to_regclass('app.workflow_drafts'))
        and (select relrowsecurity and relforcerowsecurity from pg_class where oid = to_regclass('app.workflow_versions'))
        and (select count(*) from pg_policy where polrelid in (to_regclass('app.workflows'), to_regclass('app.workflow_drafts'), to_regclass('app.workflow_versions'))) = 5
        and exists (select 1 from pg_policy p where p.polrelid = to_regclass('app.workflows') and p.polname = 'workflows_workspace_scope' and p.polqual is not null and p.polwithcheck is not null and cardinality(p.polroles) = 2 and (select oid from pg_roles where rolname = $1) = any(p.polroles) and exists (select 1 from unnest(p.polroles) policy_role where policy_role <> (select oid from pg_roles where rolname = $1) and has_function_privilege(pg_get_userbyid(policy_role), 'app.create_workflow_with_draft(uuid,uuid,character varying,uuid,integer,jsonb,character,character,character varying,character varying)', 'EXECUTE')))
        and exists (select 1 from pg_policy p where p.polrelid = to_regclass('app.workflow_drafts') and p.polname = 'workflow_drafts_workspace_scope' and p.polqual is not null and p.polwithcheck is not null and cardinality(p.polroles) = 2 and (select oid from pg_roles where rolname = $1) = any(p.polroles) and exists (select 1 from unnest(p.polroles) policy_role where policy_role <> (select oid from pg_roles where rolname = $1) and has_function_privilege(pg_get_userbyid(policy_role), 'app.create_workflow_with_draft(uuid,uuid,character varying,uuid,integer,jsonb,character,character,character varying,character varying)', 'EXECUTE')))
        and exists (select 1 from pg_policy p where p.polrelid = to_regclass('app.workflow_versions') and p.polname = 'workflow_versions_workspace_scope' and p.polqual is not null and p.polwithcheck is not null and cardinality(p.polroles) = 2 and (select oid from pg_roles where rolname = $1) = any(p.polroles) and exists (select 1 from unnest(p.polroles) policy_role where policy_role <> (select oid from pg_roles where rolname = $1) and has_function_privilege(pg_get_userbyid(policy_role), 'app.create_workflow_with_draft(uuid,uuid,character varying,uuid,integer,jsonb,character,character,character varying,character varying)', 'EXECUTE')))
        and not exists (
          select 1 from (values
            ('workflows', 'workflows_workspace_scope'),
            ('workflow_drafts', 'workflow_drafts_workspace_scope'),
            ('workflow_versions', 'workflow_versions_workspace_scope')
          ) expected(table_name, policy_name)
          where not exists (
            select 1 from pg_policy policy
            where policy.polrelid = to_regclass('app.' || expected.table_name)
              and policy.polname = expected.policy_name
              and policy.polcmd = '*'
              and cardinality(policy.polroles) = 2
              and (select oid from pg_roles where rolname = $1) = any(policy.polroles)
              and exists (
                select 1 from unnest(policy.polroles) policy_role
                where policy_role <> (select oid from pg_roles where rolname = $1)
                  and has_function_privilege(
                    pg_get_userbyid(policy_role),
                    'app.create_workflow_with_draft(uuid,uuid,character varying,uuid,integer,jsonb,character,character,character varying,character varying)',
                    'EXECUTE'
                  )
              )
              and pg_get_expr(policy.polqual, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
              and pg_get_expr(policy.polwithcheck, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
          )
        )
      ) as phase2_policy_compatible,
      (
        case when has_function_privilege(current_user, 'app.create_workflow_with_draft(uuid,uuid,character varying,uuid,integer,jsonb,character,character,character varying,character varying)', 'EXECUTE') then
        has_table_privilege(current_user, 'app.workflows', 'SELECT')
        and not has_table_privilege(current_user, 'app.workflows', 'INSERT')
        and not has_table_privilege(current_user, 'app.workflows', 'DELETE')
        and has_column_privilege(current_user, 'app.workflows', 'name', 'UPDATE')
        and has_column_privilege(current_user, 'app.workflows', 'lifecycle_status', 'UPDATE')
        and has_column_privilege(current_user, 'app.workflows', 'lifecycle_revision', 'UPDATE')
        and has_column_privilege(current_user, 'app.workflows', 'name_revision', 'UPDATE')
        and has_column_privilege(current_user, 'app.workflows', 'activation_status', 'UPDATE')
        and has_column_privilege(current_user, 'app.workflows', 'published_version_id', 'UPDATE')
        and has_column_privilege(current_user, 'app.workflows', 'updated_at', 'UPDATE')
        and not has_column_privilege(current_user, 'app.workflows', 'id', 'UPDATE')
        and not has_column_privilege(current_user, 'app.workflows', 'workspace_id', 'UPDATE')
        and not has_column_privilege(current_user, 'app.workflows', 'created_by', 'UPDATE')
        and not has_column_privilege(current_user, 'app.workflows', 'created_at', 'UPDATE')
        and has_table_privilege(current_user, 'app.workflow_drafts', 'SELECT')
        and has_column_privilege(current_user, 'app.workflow_drafts', 'revision', 'UPDATE')
        and has_column_privilege(current_user, 'app.workflow_drafts', 'schema_version', 'UPDATE')
        and has_column_privilege(current_user, 'app.workflow_drafts', 'graph_json', 'UPDATE')
        and has_column_privilege(current_user, 'app.workflow_drafts', 'updated_by', 'UPDATE')
        and has_column_privilege(current_user, 'app.workflow_drafts', 'updated_at', 'UPDATE')
        and not has_table_privilege(current_user, 'app.workflow_drafts', 'INSERT')
        and not has_table_privilege(current_user, 'app.workflow_drafts', 'DELETE')
        and not has_column_privilege(current_user, 'app.workflow_drafts', 'workflow_id', 'UPDATE')
        and not has_column_privilege(current_user, 'app.workflow_drafts', 'workspace_id', 'UPDATE')
        and has_table_privilege(current_user, 'app.workflow_versions', 'SELECT')
        and has_table_privilege(current_user, 'app.workflow_versions', 'INSERT')
        and not has_table_privilege(current_user, 'app.workflow_versions', 'UPDATE')
        and not has_table_privilege(current_user, 'app.workflow_versions', 'DELETE')
        and has_function_privilege(current_user, 'app.create_workflow_with_draft(uuid,uuid,character varying,uuid,integer,jsonb,character,character,character varying,character varying)', 'EXECUTE')
        else
          not has_table_privilege(current_user, 'app.workflows', 'SELECT')
          and not has_table_privilege(current_user, 'app.workflows', 'INSERT')
          and not has_table_privilege(current_user, 'app.workflows', 'UPDATE')
          and not has_table_privilege(current_user, 'app.workflows', 'DELETE')
          and not has_table_privilege(current_user, 'app.workflow_drafts', 'SELECT')
          and not has_table_privilege(current_user, 'app.workflow_drafts', 'INSERT')
          and not has_table_privilege(current_user, 'app.workflow_drafts', 'UPDATE')
          and not has_table_privilege(current_user, 'app.workflow_drafts', 'DELETE')
          and not has_table_privilege(current_user, 'app.workflow_versions', 'SELECT')
          and not has_table_privilege(current_user, 'app.workflow_versions', 'INSERT')
          and not has_table_privilege(current_user, 'app.workflow_versions', 'UPDATE')
          and not has_table_privilege(current_user, 'app.workflow_versions', 'DELETE')
          and not has_function_privilege(current_user, 'app.create_workflow_with_draft(uuid,uuid,character varying,uuid,integer,jsonb,character,character,character varying,character varying)', 'EXECUTE')
        end
      ) as phase2_grants_compatible,`;
