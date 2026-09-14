import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

type MigrationSet = Readonly<{
  commandLock: string;
  purgeCompletion: string;
  regionalIdentity: string;
  retention: string;
}>;

function normalizeSql(sql: string): string {
  return sql.replaceAll(/\s+/gu, ' ').trim().toLowerCase();
}

function extractFunction(sql: string, qualifiedName: string): string {
  const escapedName = qualifiedName.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const declaration = new RegExp(
    `create\\s+(?:or\\s+replace\\s+)?function\\s+${escapedName}\\s*\\(`,
    'iu',
  ).exec(sql);
  if (declaration?.index === undefined)
    throw new Error(`SQL function is missing: ${qualifiedName}`);
  const tail = sql.slice(declaration.index);
  const bodyStart = /\bas\s+(\$[a-z0-9_]*\$)/iu.exec(tail);
  const delimiter = bodyStart?.[1];
  if (bodyStart?.index === undefined || delimiter === undefined)
    throw new Error(`SQL function body is missing: ${qualifiedName}`);
  const openingEnd = bodyStart.index + bodyStart[0].length;
  const closing = tail.indexOf(delimiter, openingEnd);
  if (closing < 0)
    throw new Error(`SQL function body is unterminated: ${qualifiedName}`);
  return tail.slice(0, closing + delimiter.length + 1);
}

function assertSemanticMigrationContracts(migrations: MigrationSet): void {
  const lock = normalizeSql(
    extractFunction(
      migrations.commandLock,
      'app.lock_workspace_control_ledger',
    ),
  );
  if (
    !lock.includes('from app.workspaces workspace') ||
    !lock.includes('for update')
  )
    throw new Error('Control-ledger workspace lock changed');

  const retention = normalizeSql(
    extractFunction(
      migrations.retention,
      'app.execute_standard_retention_page',
    ),
  );
  if (!retention.includes('p_page_limit not between 1 and 1000'))
    throw new Error('Retention page bound changed');
  const normalizedRetentionMigration = normalizeSql(migrations.retention);
  if (
    !normalizedRetentionMigration.includes(
      'grant execute on function app.execute_standard_retention_page(uuid,uuid,bigint,integer,bigint,char) to {{maintenance_role}}',
    )
  )
    throw new Error('Retention execution authority changed');

  const regional = normalizeSql(migrations.regionalIdentity);
  if (
    !regional.includes(
      'drop function app.record_regional_replica_lag(varchar,varchar,bigint);',
    ) ||
    !regional.includes(
      'grant execute on function app.record_regional_replica_lag(varchar,varchar,bigint,integer) to {{maintenance_role}};',
    )
  )
    throw new Error('Regional function replacement changed');

  const prepare = normalizeSql(
    extractFunction(
      migrations.purgeCompletion,
      'app.prepare_workspace_purge_completion',
    ),
  );
  if (
    !prepare.includes('from app.workspace_legal_holds hold') ||
    !prepare.includes('hold.released_sequence is null')
  )
    throw new Error('Purge completion hold fence changed');
  const tombstone = normalizeSql(
    extractFunction(
      migrations.purgeCompletion,
      'app.block_incomplete_workspace_deletion',
    ),
  );
  for (const assignment of [
    "new.name:='deleted workspace'",
    "new.slug:='deleted-'||new.id::text",
    'new.created_by:=null',
    'new.deletion_requested_by:=null',
    "new.deletion_reason:='purged'",
  ])
    if (!tombstone.includes(assignment))
      throw new Error(`Purge tombstone field changed: ${assignment}`);
}

async function loadMigrations(): Promise<MigrationSet> {
  const migrations = await Promise.all(
    [
      '0045_control_ledger_command_lock.sql',
      '0059_workspace_purge_completion.sql',
      '0072_regional_replica_identity.sql',
      '0055_standard_retention_classes.sql',
    ].map((name) =>
      readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'),
    ),
  );
  const [commandLock, purgeCompletion, regionalIdentity, retention] =
    migrations;
  if (
    commandLock === undefined ||
    purgeCompletion === undefined ||
    regionalIdentity === undefined ||
    retention === undefined
  )
    throw new Error('Semantic migration fixture is incomplete');
  return { commandLock, purgeCompletion, regionalIdentity, retention };
}

describe('semantic migration smoke contracts', () => {
  it('accepts the published SQL across harmless layout differences', async () => {
    const migrations = await loadMigrations();
    const reformatted = {
      ...migrations,
      commandLock: migrations.commandLock.replaceAll(
        'FOR UPDATE',
        'FOR\n  UPDATE',
      ),
      retention: migrations.retention.replaceAll(
        'CREATE FUNCTION',
        'CREATE   FUNCTION',
      ),
    };
    expect(() => {
      assertSemanticMigrationContracts(reformatted);
    }).not.toThrow();
  });

  it.each([
    [
      'lock order',
      (set: MigrationSet) => ({
        ...set,
        commandLock: set.commandLock.replace('FOR UPDATE', 'FOR SHARE'),
      }),
    ],
    [
      'page bound',
      (set: MigrationSet) => ({
        ...set,
        retention: set.retention.replace(
          'p_page_limit NOT BETWEEN 1 AND 1000',
          'p_page_limit NOT BETWEEN 1 AND 1001',
        ),
      }),
    ],
    [
      'maintenance grant',
      (set: MigrationSet) => ({
        ...set,
        retention: set.retention.replace(
          'TO {{maintenance_role}};',
          'TO {{api_runtime_role}};',
        ),
      }),
    ],
    [
      'old overload removal',
      (set: MigrationSet) => ({
        ...set,
        regionalIdentity: set.regionalIdentity.replace(
          'DROP FUNCTION app.record_regional_replica_lag(varchar,varchar,bigint);',
          'SELECT 1;',
        ),
      }),
    ],
    [
      'legal-hold predicate',
      (set: MigrationSet) => ({
        ...set,
        purgeCompletion: set.purgeCompletion.replaceAll(
          'hold.released_sequence IS NULL',
          'hold.released_sequence IS NOT NULL',
        ),
      }),
    ],
    [
      'tombstone minimization',
      (set: MigrationSet) => ({
        ...set,
        purgeCompletion: set.purgeCompletion.replace(
          'NEW.created_by:=NULL',
          'NEW.created_by:=OLD.created_by',
        ),
      }),
    ],
  ])('detects the %s mutation in its bounded owner', async (_label, mutate) => {
    const migrations = await loadMigrations();
    expect(() => {
      assertSemanticMigrationContracts(mutate(migrations));
    }).toThrow();
  });
});
