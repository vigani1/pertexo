export const READINESS_CONNECTIONS_PREVIEW_SQL = `
      (
        (select count(*) = 13 from pg_attribute
         where attrelid = to_regclass('app.connections')
           and attnum > 0 and not attisdropped)
        and (select count(*) = 11 from pg_attribute
             where attrelid = to_regclass('app.connection_secret_versions')
               and attnum > 0 and not attisdropped)
        and (select count(*) = 10 from pg_attribute
             where attrelid = to_regclass('app.connection_events')
               and attnum > 0 and not attisdropped)
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.connections')
            and conname = 'connections_current_secret_same_connection_fk'
            and contype = 'f' and condeferrable and condeferred
        )
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.connections')
            and conname = 'connections_auth_type_valid'
            and pg_get_constraintdef(oid) = 'CHECK (((auth_type)::text = ANY ((ARRAY[''http_headers''::character varying, ''slack_bot_token''::character varying, ''resend_api_key''::character varying])::text[])))'
        )
        and exists (
          select 1 from pg_trigger
          where tgrelid = to_regclass('app.connection_secret_versions')
            and tgname = 'connection_secret_versions_immutable'
            and not tgisinternal
        )
        and exists (
          select 1 from pg_trigger
          where tgrelid = to_regclass('app.connection_events')
            and tgname = 'connection_events_immutable'
            and not tgisinternal
        )
        and not exists (
          select 1 from (values
            ('connections'),
            ('connection_secret_versions'),
            ('connection_events')
          ) protected(table_name)
          join pg_class protected_class
            on protected_class.oid = to_regclass('app.' || protected.table_name)
          where not protected_class.relrowsecurity
             or not protected_class.relforcerowsecurity
             or pg_get_userbyid(protected_class.relowner) <> $1
             or has_table_privilege(current_user, protected_class.oid, 'DELETE')
             or has_table_privilege(current_user, protected_class.oid, 'TRUNCATE')
             or has_table_privilege(current_user, protected_class.oid, 'REFERENCES')
             or has_table_privilege(current_user, protected_class.oid, 'TRIGGER')
        )
        and case when current_user = $2 then
          has_table_privilege(current_user, 'app.connections', 'SELECT')
          and not has_table_privilege(current_user, 'app.connections', 'INSERT')
          and has_column_privilege(current_user, 'app.connections', 'status', 'UPDATE')
          and has_column_privilege(current_user, 'app.connections', 'last_tested_at', 'UPDATE')
          and not has_column_privilege(current_user, 'app.connections', 'current_secret_version_id', 'UPDATE')
          and has_table_privilege(current_user, 'app.connection_secret_versions', 'SELECT')
          and not has_table_privilege(current_user, 'app.connection_secret_versions', 'INSERT')
          and not has_table_privilege(current_user, 'app.connection_secret_versions', 'UPDATE')
          and has_table_privilege(current_user, 'app.connection_events', 'INSERT')
          and not has_table_privilege(current_user, 'app.connection_events', 'SELECT')
          and not has_table_privilege(current_user, 'app.connection_events', 'UPDATE')
        when exists (
          select 1 from pg_policy policy
          where policy.polrelid = to_regclass('app.connections')
            and policy.polname = 'connections_workspace_scope'
            and (select oid from pg_roles where rolname = current_user) = any(policy.polroles)
        ) then
          has_table_privilege(current_user, 'app.connections', 'SELECT')
          and has_table_privilege(current_user, 'app.connections', 'INSERT')
          and has_column_privilege(current_user, 'app.connections', 'current_secret_version_id', 'UPDATE')
          and has_table_privilege(current_user, 'app.connection_secret_versions', 'SELECT')
          and has_table_privilege(current_user, 'app.connection_secret_versions', 'INSERT')
          and not has_table_privilege(current_user, 'app.connection_secret_versions', 'UPDATE')
          and has_table_privilege(current_user, 'app.connection_events', 'SELECT')
          and has_table_privilege(current_user, 'app.connection_events', 'INSERT')
          and not has_table_privilege(current_user, 'app.connection_events', 'UPDATE')
        else
          not has_table_privilege(current_user, 'app.connections', 'SELECT')
          and not has_table_privilege(current_user, 'app.connections', 'INSERT')
          and not has_table_privilege(current_user, 'app.connections', 'UPDATE')
          and not has_table_privilege(current_user, 'app.connection_secret_versions', 'SELECT')
          and not has_table_privilege(current_user, 'app.connection_secret_versions', 'INSERT')
          and not has_table_privilege(current_user, 'app.connection_secret_versions', 'UPDATE')
          and not has_table_privilege(current_user, 'app.connection_events', 'SELECT')
          and not has_table_privilege(current_user, 'app.connection_events', 'INSERT')
          and not has_table_privilege(current_user, 'app.connection_events', 'UPDATE')
        end
      ) as phase4_connections_compatible,
      (
        (select count(*) = 5 from pg_attribute
         where attrelid = to_regclass('app.workflow_integration_usage')
           and attnum > 0 and not attisdropped)
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.workflow_integration_usage')
            and conname = 'workflow_integration_usage_identity_pk'
            and contype = 'p'
        )
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.workflow_integration_usage')
            and conname = 'workflow_integration_usage_version_fk'
            and contype = 'f'
        )
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.workflow_integration_usage')
            and conname = 'workflow_integration_usage_connection_fk'
            and contype = 'f'
        )
        and exists (
          select 1 from pg_class protected
          where protected.oid = to_regclass('app.workflow_integration_usage')
            and protected.relrowsecurity
            and protected.relforcerowsecurity
            and pg_get_userbyid(protected.relowner) = $1
        )
        and exists (
          select 1 from pg_policy policy
          where policy.polrelid = to_regclass('app.workflow_integration_usage')
            and policy.polname = 'workflow_integration_usage_workspace_scope'
            and policy.polcmd = '*'
            and cardinality(policy.polroles) = 2
            and (select oid from pg_roles where rolname = $1) = any(policy.polroles)
            and not ((select oid from pg_roles where rolname = $2) = any(policy.polroles))
            and pg_get_expr(policy.polqual, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
            and pg_get_expr(policy.polwithcheck, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
        )
        and case when exists (
          select 1 from pg_policy policy
          where policy.polrelid = to_regclass('app.workflow_integration_usage')
            and (select oid from pg_roles where rolname = current_user) = any(policy.polroles)
        ) then
          has_table_privilege(current_user, 'app.workflow_integration_usage', 'SELECT')
          and has_table_privilege(current_user, 'app.workflow_integration_usage', 'INSERT')
          and not has_table_privilege(current_user, 'app.workflow_integration_usage', 'UPDATE')
          and has_table_privilege(current_user, 'app.workflow_integration_usage', 'DELETE')
        else
          not has_table_privilege(current_user, 'app.workflow_integration_usage', 'SELECT')
          and not has_table_privilege(current_user, 'app.workflow_integration_usage', 'INSERT')
          and not has_table_privilege(current_user, 'app.workflow_integration_usage', 'UPDATE')
          and not has_table_privilege(current_user, 'app.workflow_integration_usage', 'DELETE')
        end
        and not has_table_privilege(current_user, 'app.workflow_integration_usage', 'TRUNCATE')
        and not has_table_privilege(current_user, 'app.workflow_integration_usage', 'REFERENCES')
        and not has_table_privilege(current_user, 'app.workflow_integration_usage', 'TRIGGER')
      ) as phase4_integration_usage_compatible,
      (
        (select count(*) = 5 from pg_attribute
         where attrelid = to_regclass('app.artifact_links')
           and attnum > 0 and not attisdropped)
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.artifact_links')
            and conname = 'artifact_links_identity_unique'
            and contype = 'p'
        )
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.artifact_links')
            and conname = 'artifact_links_artifact_fk'
            and contype = 'f'
        )
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.artifact_links')
            and conname = 'artifact_links_preview_run_fk'
            and contype = 'f'
        )
        and exists (
          select 1 from pg_trigger
          where tgrelid = to_regclass('app.artifact_links')
            and tgname = 'artifact_link_preview_retention'
            and not tgisinternal
        )
        and exists (
          select 1 from pg_proc routine
          where routine.oid = to_regprocedure('app.complete_preview_cleanup(uuid,uuid)')
            and routine.prosecdef
            and pg_get_userbyid(routine.proowner) = $1
            and not has_function_privilege($2, routine.oid, 'EXECUTE')
        )
        and exists (
          select 1 from pg_class protected
          where protected.oid = to_regclass('app.artifact_links')
            and protected.relrowsecurity
            and protected.relforcerowsecurity
            and pg_get_userbyid(protected.relowner) = $1
        )
        and exists (
          select 1 from pg_policy policy
          where policy.polrelid = to_regclass('app.artifact_links')
            and policy.polname = 'artifact_links_workspace_scope'
            and policy.polcmd = '*'
            and cardinality(policy.polroles) = 3
            and (select oid from pg_roles where rolname = $1) = any(policy.polroles)
            and (select oid from pg_roles where rolname = $2) = any(policy.polroles)
            and pg_get_expr(policy.polqual, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
            and pg_get_expr(policy.polwithcheck, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
        )
        and case when exists (
          select 1 from pg_policy policy
          where policy.polrelid = to_regclass('app.artifact_links')
            and (select oid from pg_roles where rolname = current_user) = any(policy.polroles)
        ) then
          has_table_privilege(current_user, 'app.artifact_links', 'SELECT')
          and case when current_user = $2 then
            has_table_privilege(current_user, 'app.artifact_links', 'INSERT')
          else
            not has_table_privilege(current_user, 'app.artifact_links', 'INSERT')
          end
        else
          not has_table_privilege(current_user, 'app.artifact_links', 'SELECT')
          and not has_table_privilege(current_user, 'app.artifact_links', 'INSERT')
        end
        and not has_table_privilege(current_user, 'app.artifact_links', 'UPDATE')
        and not has_table_privilege(current_user, 'app.artifact_links', 'DELETE')
        and not has_table_privilege(current_user, 'app.artifact_links', 'TRUNCATE')
        and not has_table_privilege(current_user, 'app.artifact_links', 'REFERENCES')
        and not has_table_privilege(current_user, 'app.artifact_links', 'TRIGGER')
      ) as phase4_preview_artifacts_compatible,
      (
        (select count(*) = 9 from pg_attribute
         where attrelid = to_regclass('app.usage_events')
           and attnum > 0 and not attisdropped)
        and not exists (
          select 1
          from (values
            ('id', 'uuid'),
            ('workspace_id', 'uuid'),
            ('category', 'character varying(64)'),
            ('quantity', 'bigint'),
            ('resource_type', 'character varying(64)'),
            ('resource_id', 'uuid'),
            ('idempotency_key', 'character varying(128)'),
            ('metadata', 'jsonb'),
            ('occurred_at', 'timestamp with time zone')
          ) expected(attname, type_name)
          where not exists (
            select 1 from pg_attribute attribute
            where attribute.attrelid = to_regclass('app.usage_events')
              and attribute.attname = expected.attname
              and format_type(attribute.atttypid, attribute.atttypmod) = expected.type_name
              and attribute.attnotnull
              and not attribute.attisdropped
          )
        )
        and exists (
          select 1 from pg_attribute attribute
          join pg_attrdef default_value
            on default_value.adrelid = attribute.attrelid
           and default_value.adnum = attribute.attnum
          where attribute.attrelid = to_regclass('app.usage_events')
            and attribute.attname = 'metadata'
            and pg_get_expr(default_value.adbin, default_value.adrelid) = '''{}''::jsonb'
        )
        and exists (
          select 1 from pg_attribute attribute
          join pg_attrdef default_value
            on default_value.adrelid = attribute.attrelid
           and default_value.adnum = attribute.attnum
          where attribute.attrelid = to_regclass('app.usage_events')
            and attribute.attname = 'occurred_at'
            and pg_get_expr(default_value.adbin, default_value.adrelid) = 'clock_timestamp()'
        )
        and not exists (
          select 1
          from (values
            ('usage_events_pkey', 'p', true, 'PRIMARY KEY (id)'),
            ('usage_events_workspace_fk', 'f', true, 'FOREIGN KEY (workspace_id) REFERENCES app.workspaces(id) ON DELETE RESTRICT'),
            ('usage_events_category_format', 'c', true, 'CHECK (((category)::text ~ ''^[a-z][a-z0-9._:-]{0,63}$''::text))'),
            ('usage_events_quantity_positive', 'c', true, 'CHECK ((quantity > 0))'),
            ('usage_events_resource_type_format', 'c', true, 'CHECK (((resource_type)::text ~ ''^[a-z][a-z0-9._:-]{0,63}$''::text))'),
            ('usage_events_idempotency_key_format', 'c', true, 'CHECK (((idempotency_key)::text ~ ''^[A-Za-z0-9._:-]{1,128}$''::text))'),
            ('usage_events_metadata_bounded', 'c', true, 'CHECK ((octet_length((metadata)::text) <= 4096))'),
            ('usage_events_workspace_idempotency_unique', 'u', true, 'UNIQUE (workspace_id, idempotency_key)'),
            ('usage_events_preview_uuid_v7', 'c', false, 'CHECK ((((category)::text <> ''preview_execution''::text) OR (uuid_extract_version(id) = 7))) NOT VALID')
          ) expected(conname, contype, convalidated, definition)
          where not exists (
            select 1 from pg_constraint constraint_record
            where constraint_record.conrelid = to_regclass('app.usage_events')
              and constraint_record.conname = expected.conname
              and constraint_record.contype = expected.contype::char
              and constraint_record.convalidated = expected.convalidated
              and pg_get_constraintdef(constraint_record.oid) = expected.definition
          )
        )
        and not exists (
          select 1
          from (values
            ('usage_events_workspace_period_idx', 'CREATE INDEX usage_events_workspace_period_idx ON app.usage_events USING btree (workspace_id, occurred_at DESC, id)'),
            ('usage_events_resource_idx', 'CREATE INDEX usage_events_resource_idx ON app.usage_events USING btree (workspace_id, resource_type, resource_id, id)')
          ) expected(indexname, definition)
          where not exists (
            select 1 from pg_indexes index_record
            where index_record.schemaname = 'app'
              and index_record.tablename = 'usage_events'
              and index_record.indexname = expected.indexname
              and index_record.indexdef = expected.definition
          )
        )
        and not exists (
          select 1
          from (values
            ('request_id', 'character varying(128)'),
            ('trace_id', 'character varying(128)'),
            ('provider_key', 'character varying(64)'),
            ('operation_key', 'character varying(128)')
          ) expected(attname, type_name)
          where not exists (
            select 1 from pg_attribute attribute
            where attribute.attrelid = to_regclass('app.preview_runs')
              and attribute.attname = expected.attname
              and format_type(attribute.atttypid, attribute.atttypmod) = expected.type_name
              and not attribute.attnotnull
              and not attribute.attisdropped
          )
        )
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.preview_runs')
            and conname = 'preview_runs_integration_identity_consistent'
            and contype = 'c'
            and convalidated
            and pg_get_constraintdef(oid) = 'CHECK ((((provider_key IS NULL) AND (operation_key IS NULL)) OR (((provider_key)::text ~ ''^[a-z][a-z0-9._:-]{0,63}$''::text) AND ((operation_key)::text ~ ''^[a-z][a-z0-9._:-]{0,127}$''::text))))'
        )
        and exists (
          select 1 from pg_attribute attribute
          where attribute.attrelid = to_regclass('app.preview_runs')
            and attribute.attname = 'execution_deadline_at'
            and attribute.atttypid = 'timestamptz'::regtype
            and attribute.attnotnull
            and not attribute.attisdropped
        )
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.preview_runs')
            and conname = 'preview_runs_execution_deadline_order'
            and contype = 'c'
            and convalidated
            and pg_get_constraintdef(oid) = 'CHECK (((execution_deadline_at > created_at) AND (execution_deadline_at <= expires_at)))'
        )
        and exists (
          select 1 from pg_constraint
          where conrelid = to_regclass('app.audit_events')
            and conname = 'audit_events_preview_terminal_uuid_v7'
            and contype = 'c'
            and not convalidated
            and pg_get_constraintdef(oid) = 'CHECK ((((action)::text <> ''preview.execution_terminal''::text) OR (uuid_extract_version(id) = 7))) NOT VALID'
        )
        and exists (
          select 1 from pg_trigger
          where tgrelid = to_regclass('app.preview_runs')
            and tgname = 'preview_run_pins_immutable'
            and not tgisinternal
            and tgenabled = 'O'
            and pg_get_triggerdef(oid) = 'CREATE TRIGGER preview_run_pins_immutable BEFORE UPDATE ON app.preview_runs FOR EACH ROW EXECUTE FUNCTION app.reject_preview_run_pin_change()'
        )
        and exists (
          select 1 from pg_proc
          where oid = to_regprocedure('app.reject_preview_run_pin_change()')
            and md5(prosrc) = 'e3e80198979101aabfc681553bcdbedf'
            and pg_get_userbyid(proowner) = $1
            and prolang = (select oid from pg_language where lanname = 'plpgsql')
            and proconfig = array['search_path=pg_catalog, pg_temp']::text[]
            and not prosecdef
        )
        and exists (
          select 1 from pg_class protected
          where protected.oid = to_regclass('app.usage_events')
            and protected.relrowsecurity
            and protected.relforcerowsecurity
            and pg_get_userbyid(protected.relowner) = $1
        )
        and exists (
          select 1 from pg_policy policy
          where policy.polrelid = to_regclass('app.usage_events')
            and policy.polname = 'usage_events_workspace_select'
            and policy.polcmd = 'r'
            and cardinality(policy.polroles) = 3
            and (select oid from pg_roles where rolname = $1) = any(policy.polroles)
            and (select oid from pg_roles where rolname = $2) = any(policy.polroles)
            and pg_get_expr(policy.polqual, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
            and policy.polwithcheck is null
        )
        and exists (
          select 1 from pg_policy policy
          where policy.polrelid = to_regclass('app.usage_events')
            and policy.polname = 'usage_events_workspace_insert'
            and policy.polcmd = 'a'
            and cardinality(policy.polroles) = 2
            and (select oid from pg_roles where rolname = $1) = any(policy.polroles)
            and (select oid from pg_roles where rolname = $2) = any(policy.polroles)
            and policy.polqual is null
            and pg_get_expr(policy.polwithcheck, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
        )
        and exists (
          select 1 from pg_policy policy
          where policy.polrelid = to_regclass('app.audit_events')
            and policy.polname = 'audit_events_workspace_insert'
            and policy.polcmd = 'a'
            and (select oid from pg_roles where rolname = $2) = any(policy.polroles)
            and pg_get_expr(policy.polwithcheck, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
        )
        and has_table_privilege($2, 'app.audit_events', 'INSERT')
        and has_table_privilege($2, 'app.usage_events', 'SELECT')
        and has_table_privilege($2, 'app.usage_events', 'INSERT')
        and not has_table_privilege($2, 'app.usage_events', 'UPDATE')
        and not has_table_privilege($2, 'app.usage_events', 'DELETE')
        and not has_table_privilege($2, 'app.usage_events', 'TRUNCATE')
        and not has_table_privilege($2, 'app.usage_events', 'REFERENCES')
        and not has_table_privilege($2, 'app.usage_events', 'TRIGGER')
        and case when current_user = $2 then
          has_table_privilege(current_user, 'app.audit_events', 'INSERT')
          and has_table_privilege(current_user, 'app.usage_events', 'SELECT')
          and has_table_privilege(current_user, 'app.usage_events', 'INSERT')
        when exists (
          select 1 from pg_policy policy
          where policy.polrelid = to_regclass('app.usage_events')
            and policy.polname = 'usage_events_workspace_select'
            and (select oid from pg_roles where rolname = current_user) = any(policy.polroles)
        ) then
          has_table_privilege(current_user, 'app.usage_events', 'SELECT')
          and not has_table_privilege(current_user, 'app.usage_events', 'INSERT')
        else
          not has_table_privilege(current_user, 'app.usage_events', 'SELECT')
          and not has_table_privilege(current_user, 'app.usage_events', 'INSERT')
        end
        and not has_table_privilege(current_user, 'app.usage_events', 'UPDATE')
        and not has_table_privilege(current_user, 'app.usage_events', 'DELETE')
        and not has_table_privilege(current_user, 'app.usage_events', 'TRUNCATE')
        and not has_table_privilege(current_user, 'app.usage_events', 'REFERENCES')
        and not has_table_privilege(current_user, 'app.usage_events', 'TRIGGER')
      ) as phase4_preview_terminal_facts_compatible,`;
