import assert from 'node:assert/strict';
import test from 'node:test';
import { SQL_FUNCTION_ALLOWLIST } from './sql-function-allowlist.mjs';
import {
  validateSqlFunctionInventory,
  validateSqlFunctionSources,
} from './validate-sql-functions.mjs';

const allowed = 'app.claim_workspace_inbox_events';

test('categorizes every remaining migration function without retaining retired rules', async () => {
  assert.deepEqual(await validateSqlFunctionInventory(), {
    functionCount: Object.keys(SQL_FUNCTION_ALLOWLIST).length,
  });
});

test('rejects a reintroduced Inbox fold rule', () => {
  assert.throws(
    () =>
      validateSqlFunctionSources(
        `CREATE FUNCTION app.fold_workspace_inbox_events(p_limit integer,p_window interval) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;`,
      ),
    /fold_workspace_inbox_events.*category/u,
  );
});

test('requires a separate decision for a new overload of an allowed function', () => {
  assert.throws(
    () =>
      validateSqlFunctionSources(
        `CREATE FUNCTION ${allowed}(p_limit integer,p_policy text) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;`,
      ),
    /claim_workspace_inbox_events\(integer,text\).*category/u,
  );
});

test('tracks replacement and quoted function identities across migration drops', () => {
  assert.deepEqual(
    validateSqlFunctionSources(`
    CREATE FUNCTION "app"."claim_workspace_inbox_events"(IN p_limit int4 DEFAULT 100) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
    CREATE OR REPLACE FUNCTION ${allowed}(p_limit integer) RETURNS void LANGUAGE sql AS $body$ SELECT 2 $body$;
    CREATE FUNCTION app.retired_rule(p_limit integer) RETURNS void LANGUAGE sql AS $$ SELECT 3 $$;
    DROP FUNCTION IF EXISTS "app".retired_rule(integer);
  `),
    [`${allowed}(integer)`],
  );
});

test('does not confuse comments, quoted SQL or routine bodies with function declarations', () => {
  assert.deepEqual(
    validateSqlFunctionSources(`
    -- CREATE FUNCTION app.comment_rule() RETURNS void;
    /* outer /* CREATE FUNCTION app.nested_comment() */ comment */
    CREATE FUNCTION ${allowed}(p_limit integer) RETURNS void LANGUAGE plpgsql AS $body$
    BEGIN
      PERFORM 'CREATE FUNCTION app.quoted_rule() RETURNS void;';
      -- body semicolons do not start top-level DDL
      RETURN;
    END $body$;
    SELECT 'CREATE FUNCTION app.ordinary_string() RETURNS void;';
  `),
    [`${allowed}(integer)`],
  );
});

test('does not let dropping one overload hide a different unreviewed signature', () => {
  assert.throws(
    () =>
      validateSqlFunctionSources(`
    CREATE FUNCTION ${allowed}(p_limit integer) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
    CREATE FUNCTION ${allowed}(p_limit bigint) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
    DROP FUNCTION ${allowed}(integer);
  `),
    /claim_workspace_inbox_events\(bigint\).*category/u,
  );
});

test('normalizes storage type modifiers and aliases without changing argument identity', () => {
  assert.deepEqual(
    validateSqlFunctionSources(`
    CREATE FUNCTION app.claim_due_trigger_schedules(p_lease_owner varchar(128),p_limit int,p_lease_seconds int4)
      RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
    DROP FUNCTION app.claim_due_trigger_schedules(character varying,integer,integer);
  `),
    [],
  );
});

test('does not confuse quoted mixed-case function names with reviewed identities', () => {
  assert.throws(
    () =>
      validateSqlFunctionSources(`
    CREATE FUNCTION app."Claim_workspace_inbox_events"(p_limit integer)
      RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
  `),
    /Claim_workspace_inbox_events.*category/u,
  );
});
