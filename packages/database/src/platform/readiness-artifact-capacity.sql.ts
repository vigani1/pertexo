export const READINESS_ARTIFACT_CAPACITY_SQL = `
      (
        exists (
          select 1
          from pg_class relation
          where relation.oid = to_regclass('app.workspace_artifact_capacity')
            and pg_get_userbyid(relation.relowner) = $1
            and relation.relrowsecurity
            and relation.relforcerowsecurity
        )
        and (
          select count(*) = 7
          from pg_attribute attribute
          where attribute.attrelid = to_regclass('app.workspace_artifact_capacity')
            and attribute.attnum > 0
            and not attribute.attisdropped
        )
        and not exists (
          select 1
          from (values
            ('workspace_id', 'uuid'::regtype, true),
            ('byte_limit', 'bigint'::regtype, true),
            ('artifact_count_limit', 'integer'::regtype, true),
            ('charged_bytes', 'bigint'::regtype, true),
            ('charged_count', 'integer'::regtype, true),
            ('created_at', 'timestamp with time zone'::regtype, true),
            ('updated_at', 'timestamp with time zone'::regtype, true)
          ) expected(column_name, data_type, required_not_null)
          where not exists (
            select 1
            from pg_attribute attribute
            where attribute.attrelid = to_regclass('app.workspace_artifact_capacity')
              and attribute.attnum > 0
              and not attribute.attisdropped
              and attribute.attname = expected.column_name
              and attribute.atttypid = expected.data_type
              and attribute.attnotnull = expected.required_not_null
          )
        )
        and not exists (
          select 1
          from (values
            ('workspace_id', null::text),
            ('byte_limit', '1073741824'),
            ('artifact_count_limit', '1000'),
            ('charged_bytes', '0'),
            ('charged_count', '0'),
            ('created_at', 'clock_timestamp()'),
            ('updated_at', 'clock_timestamp()')
          ) expected(column_name, default_expression)
          where not exists (
            select 1
            from pg_attribute attribute
            left join pg_attrdef default_value
              on default_value.adrelid = attribute.attrelid
             and default_value.adnum = attribute.attnum
            where attribute.attrelid = to_regclass('app.workspace_artifact_capacity')
              and attribute.attnum > 0
              and not attribute.attisdropped
              and attribute.attname = expected.column_name
              and case
                when expected.default_expression is null
                  then default_value.oid is null
                else pg_get_expr(default_value.adbin, default_value.adrelid) =
                  expected.default_expression
              end
          )
        )
        and exists (
          select 1
          from pg_constraint constraint_record
          where constraint_record.conrelid = to_regclass('app.workspace_artifact_capacity')
            and constraint_record.conname = 'workspace_artifact_capacity_pkey'
            and constraint_record.contype = 'p'
            and pg_get_constraintdef(constraint_record.oid) =
              'PRIMARY KEY (workspace_id)'
        )
        and not exists (
          select 1
          from (values
            (
              'workspace_artifact_capacity_byte_limit_valid',
              'CHECK ((byte_limit >= 0))'
            ),
            (
              'workspace_artifact_capacity_count_limit_valid',
              'CHECK ((artifact_count_limit >= 0))'
            ),
            (
              'workspace_artifact_capacity_charged_bytes_valid',
              'CHECK ((charged_bytes >= 0))'
            ),
            (
              'workspace_artifact_capacity_charged_count_valid',
              'CHECK ((charged_count >= 0))'
            )
          ) expected(constraint_name, definition)
          where not exists (
            select 1
            from pg_constraint constraint_record
            where constraint_record.conrelid = to_regclass('app.workspace_artifact_capacity')
              and constraint_record.conname = expected.constraint_name
              and constraint_record.contype = 'c'
              and constraint_record.convalidated
              and pg_get_constraintdef(constraint_record.oid) = expected.definition
          )
        )
        and (
          select count(*) = 2
          from pg_policy policy
          where policy.polrelid = to_regclass('app.workspace_artifact_capacity')
        )
        and exists (
          select 1
          from pg_policy policy
          where policy.polrelid = to_regclass('app.workspace_artifact_capacity')
            and policy.polname = 'workspace_artifact_capacity_owner_all'
            and policy.polcmd = '*'
            and cardinality(policy.polroles) = 1
            and policy.polroles[1] = (select oid from pg_roles where rolname = $1)
            and pg_get_expr(policy.polqual, policy.polrelid) = 'true'
            and pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
        )
        and exists (
          select 1
          from pg_policy policy
          where policy.polrelid = to_regclass('app.workspace_artifact_capacity')
            and policy.polname = 'workspace_artifact_capacity_workspace_scope'
            and policy.polcmd = '*'
            and cardinality(policy.polroles) = 2
            and (select oid from pg_roles where rolname = $2) = any(policy.polroles)
            and (select oid from pg_roles where rolname = $3) = any(policy.polroles)
            and pg_get_expr(policy.polqual, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
            and pg_get_expr(policy.polwithcheck, policy.polrelid) = '((workspace_id)::text = NULLIF(current_setting(''app.workspace_id''::text, true), ''''::text))'
        )
        and exists (
          select 1
          from pg_class relation
          where relation.oid = to_regclass('app.workspace_artifact_capacity')
            and not exists (
              select 1
              from aclexplode(coalesce(
                relation.relacl,
                acldefault('r', relation.relowner)
              )) privilege
              where privilege.grantee = 0
                or privilege.grantee not in (
                  (select oid from pg_roles where rolname = $1),
                  (select oid from pg_roles where rolname = $2),
                  (select oid from pg_roles where rolname = $3)
                )
                or privilege.is_grantable
                or (
                  privilege.grantee in (
                    (select oid from pg_roles where rolname = $2),
                    (select oid from pg_roles where rolname = $3)
                  )
                  and privilege.privilege_type <> 'SELECT'
                )
            )
            and not exists (
              select 1
              from (values
                ('INSERT'), ('SELECT'), ('UPDATE'), ('DELETE'),
                ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
              ) expected(privilege_type)
              where not exists (
                select 1
                from aclexplode(coalesce(
                  relation.relacl,
                  acldefault('r', relation.relowner)
                )) privilege
                where privilege.grantee =
                    (select oid from pg_roles where rolname = $1)
                  and privilege.privilege_type = expected.privilege_type
              )
            )
            and has_table_privilege($2, relation.oid, 'SELECT')
            and has_table_privilege($3, relation.oid, 'SELECT')
            and not exists (
              select 1
              from (values
                ('workspace_id'), ('byte_limit'), ('artifact_count_limit'),
                ('charged_bytes'), ('charged_count'), ('created_at'),
                ('updated_at')
              ) expected(column_name)
              where has_column_privilege(
                  $2, relation.oid, expected.column_name, 'INSERT'
                )
                or has_column_privilege(
                  $2, relation.oid, expected.column_name, 'UPDATE'
                )
                or has_column_privilege(
                  $2, relation.oid, expected.column_name, 'REFERENCES'
                )
            )
            and not exists (
              select 1
              from (values
                ('workspace_id'), ('byte_limit'), ('artifact_count_limit'),
                ('charged_bytes'), ('charged_count'), ('created_at'),
                ('updated_at')
              ) expected(column_name)
              where has_column_privilege(
                  $3, relation.oid, expected.column_name, 'INSERT'
                )
                or has_column_privilege(
                  $3, relation.oid, expected.column_name, 'UPDATE'
                )
                or has_column_privilege(
                  $3, relation.oid, expected.column_name, 'REFERENCES'
                )
            )
        )
        and (
          case
            when to_regclass('app.workspace_artifact_capacity') is null then false
            when current_user in ($2, $3) then
              has_table_privilege(current_user, 'app.workspace_artifact_capacity', 'SELECT')
              and not has_table_privilege(current_user, 'app.workspace_artifact_capacity', 'INSERT')
              and not has_table_privilege(current_user, 'app.workspace_artifact_capacity', 'UPDATE')
              and not has_table_privilege(current_user, 'app.workspace_artifact_capacity', 'DELETE')
              and not has_table_privilege(current_user, 'app.workspace_artifact_capacity', 'TRUNCATE')
              and not has_table_privilege(current_user, 'app.workspace_artifact_capacity', 'REFERENCES')
              and not has_table_privilege(current_user, 'app.workspace_artifact_capacity', 'TRIGGER')
              and not exists (
                select 1
                from (values
                  ('workspace_id'), ('byte_limit'), ('artifact_count_limit'),
                  ('charged_bytes'), ('charged_count'), ('created_at'),
                  ('updated_at')
                ) expected(column_name)
                where has_column_privilege(
                    current_user, 'app.workspace_artifact_capacity',
                    expected.column_name, 'INSERT'
                  )
                  or has_column_privilege(
                    current_user, 'app.workspace_artifact_capacity',
                    expected.column_name, 'UPDATE'
                  )
                  or has_column_privilege(
                    current_user, 'app.workspace_artifact_capacity',
                    expected.column_name, 'REFERENCES'
                  )
              )
            else
              not has_table_privilege(current_user, 'app.workspace_artifact_capacity', 'SELECT')
              and not has_table_privilege(current_user, 'app.workspace_artifact_capacity', 'INSERT')
              and not has_table_privilege(current_user, 'app.workspace_artifact_capacity', 'UPDATE')
              and not has_table_privilege(current_user, 'app.workspace_artifact_capacity', 'DELETE')
              and not has_table_privilege(current_user, 'app.workspace_artifact_capacity', 'TRUNCATE')
              and not has_table_privilege(current_user, 'app.workspace_artifact_capacity', 'REFERENCES')
              and not has_table_privilege(current_user, 'app.workspace_artifact_capacity', 'TRIGGER')
              and not exists (
                select 1
                from (values
                  ('workspace_id'), ('byte_limit'), ('artifact_count_limit'),
                  ('charged_bytes'), ('charged_count'), ('created_at'),
                  ('updated_at')
                ) expected(column_name)
                where has_column_privilege(
                    current_user, 'app.workspace_artifact_capacity',
                    expected.column_name, 'SELECT'
                  )
                  or has_column_privilege(
                    current_user, 'app.workspace_artifact_capacity',
                    expected.column_name, 'INSERT'
                  )
                  or has_column_privilege(
                    current_user, 'app.workspace_artifact_capacity',
                    expected.column_name, 'UPDATE'
                  )
                  or has_column_privilege(
                    current_user, 'app.workspace_artifact_capacity',
                    expected.column_name, 'REFERENCES'
                  )
              )
          end
        )
        and not exists (
          select 1
          from (values
            ('artifact_capacity_transition()'),
            ('artifact_capacity_purge_start()')
          ) expected(signature)
          where not exists (
            select 1
            from pg_proc function_record
            join pg_language language_record
              on language_record.oid = function_record.prolang
            where function_record.oid =
                to_regprocedure('app.' || expected.signature)
              and language_record.lanname = 'plpgsql'
              and function_record.prosecdef
              and pg_get_userbyid(function_record.proowner) = $1
              and function_record.proconfig = array[
                'search_path=pg_catalog, app, pg_temp',
                'row_security=on'
              ]::text[]
              and not exists (
                select 1
                from aclexplode(coalesce(
                  function_record.proacl,
                  acldefault('f', function_record.proowner)
                )) privilege
                where privilege.grantee <> function_record.proowner
                   or privilege.privilege_type <> 'EXECUTE'
                   or privilege.is_grantable
              )
              and exists (
                select 1
                from aclexplode(coalesce(
                  function_record.proacl,
                  acldefault('f', function_record.proowner)
                )) privilege
                where privilege.grantee = function_record.proowner
                  and privilege.privilege_type = 'EXECUTE'
              )
          )
        )
        and not exists (
          select 1
          from (values
            ('app.artifacts', 'artifacts_capacity_transition', 31),
            ('app.workspaces', 'workspace_artifact_capacity_purge_start', 19)
          ) expected(relation_name, trigger_name, trigger_type)
          where not exists (
            select 1
            from pg_trigger trigger_record
            where trigger_record.tgrelid = to_regclass(expected.relation_name)
              and trigger_record.tgname = expected.trigger_name
              and trigger_record.tgenabled = 'O'
              and trigger_record.tgtype = expected.trigger_type
              and not trigger_record.tgisinternal
              and trigger_record.tgfoid = to_regprocedure(
                case expected.trigger_name
                  when 'artifacts_capacity_transition'
                    then 'app.artifact_capacity_transition()'
                  else 'app.artifact_capacity_purge_start()'
                end
              )
          )
        )
      ) as artifact_capacity_compatible,
`;
