import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRetentionStore } from '../../src/lifecycle/retention/store.js';
import {
  adminUrl,
  maintenanceUrl,
  parseDatabaseConfig,
  retention,
  waitForPostgresLock,
  withApplicationName,
  withDatabase,
} from './retention.support.js';
import {
  REVIVED_RULES,
  WINDOWED_RULES,
  type WindowedRule,
} from './retention-windows/rows.js';

const DAY = 86_400_000;
const MINUTE = 60_000;

let seeder!: Client;

beforeAll(async () => {
  seeder = new Client({ connectionString: withDatabase(adminUrl) });
  await seeder.connect();
  // Only for seeding: a rule's window doesn't read the parents these rows skip.
  await seeder.query(`set session_replication_role=replica`);
});

afterAll(async () => {
  await seeder.end();
});

async function seed(rule: WindowedRule, at: Date): Promise<string> {
  const row = rule.row(at);
  const columns = Object.keys(row);
  await seeder.query(
    `insert into app.${rule.table}(${columns.join(',')})
     values(${columns.map((_, index) => `$${String(index + 1)}`).join(',')})`,
    Object.values(row),
  );
  return String(row[rule.key ?? 'id']);
}

async function surviving(
  rule: WindowedRule,
  keys: readonly string[],
): Promise<readonly string[]> {
  const column = rule.key ?? 'id';
  const result = await seeder.query<{ key: string }>(
    `select ${column}::text "key" from app.${rule.table}
      where ${column}::text=any($1::text[])`,
    [[...keys]],
  );
  return result.rows.map(({ key }) => key);
}

const clockFor = (rule: WindowedRule, offset: number) =>
  new Date(Date.now() - rule.windowDays * DAY + offset);

describe.each(WINDOWED_RULES)('the $rule rule', (rule) => {
  it(`takes a row a minute past ${String(rule.windowDays)} days a page at a time, and keeps one a minute inside`, async () => {
    const past = [
      await seed(rule, clockFor(rule, -MINUTE)),
      await seed(rule, clockFor(rule, -MINUTE)),
      await seed(rule, clockFor(rule, -MINUTE)),
    ];
    const inside = await seed(rule, clockFor(rule, MINUTE));

    const first = await retention.enforce();
    // The store's page is two rows, so one row must wait for the next pass.
    expect(first.removed[rule.rule]).toBe(2);
    expect(first.more).toBe(true);
    expect(await surviving(rule, [...past, inside])).toHaveLength(2);

    const second = await retention.enforce();
    expect(second.removed[rule.rule]).toBe(1);
    expect(await surviving(rule, [...past, inside])).toEqual([inside]);

    const third = await retention.enforce();
    expect(third.removed[rule.rule]).toBe(0);
    expect(await surviving(rule, [inside])).toEqual([inside]);
  });
});

describe.each(REVIVED_RULES)(
  '$rule while its delete waits',
  ({ rule, revive }) => {
    it('keeps a row changed under the delete', async () => {
      const windowed = WINDOWED_RULES.find(
        (candidate) => candidate.rule === rule,
      );
      if (windowed === undefined) throw new Error(`No row for ${rule}`);
      const key = await seed(windowed, clockFor(windowed, -MINUTE));
      const applicationName = `retention-revive-${randomUUID()}`;
      const store = createRetentionStore(
        parseDatabaseConfig({
          connectionString: withApplicationName(
            maintenanceUrl,
            applicationName,
          ),
          max: 1,
        }),
        { pageSize: 2 },
      );
      const writer = new Client({ connectionString: withDatabase(adminUrl) });
      await writer.connect();
      try {
        await writer.query('begin');
        await writer.query(
          `update app.${windowed.table} set ${revive}
          where ${windowed.key ?? 'id'}::text=$1`,
          [key],
        );
        const pass = store.enforce();
        await waitForPostgresLock(applicationName);
        await writer.query('commit');

        expect((await pass).removed[rule]).toBe(0);
        expect(await surviving(windowed, [key])).toEqual([key]);
      } finally {
        await writer.query('rollback').catch(() => undefined);
        await writer.end();
        await store.close();
      }
    });
  },
);
