import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  curatedDatabaseUrl,
  curatedRedisUrl,
  recheckCuratedFixtureOwnership,
  verifyCuratedFixtureOwnership,
} from './curated-template-owned-fixture.mjs';

export async function createCuratedCutoverResources(repository) {
  // pg/ioredis are declared by apps/api, the explicit fixture dependency owner.
  // Knip cannot attribute createRequire's workspace anchor; only this fixture's
  // unlisted diagnostic is exempted, with literal dependencies kept visible.
  const require = createRequire(path.join(repository, 'apps/api/package.json'));
  const { Pool } = require('pg'),
    Redis = require('ioredis').default;
  const owned = await verifyCuratedFixtureOwnership();
  const name = `pertexo_test_f06_cutover_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const redisUrl = curatedRedisUrl(owned.redisUrl, 12);
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: 3000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  const lease = 'pertexo:f06:cutover:owner',
    token = randomUUID();
  let acquired = false,
    created = false;
  const admin = new Pool({
    connectionString: owned.adminUrl,
    max: 1,
    connectionTimeoutMillis: 3000,
  });
  const apiUrl = curatedDatabaseUrl(owned.apiUrl, name);
  const migrationUrl = curatedDatabaseUrl(owned.migrationUrl, name);
  const inspector = new Pool({
    connectionString: curatedDatabaseUrl(owned.adminUrl, name),
    max: 1,
    connectionTimeoutMillis: 3000,
  });
  async function close() {
    const failures = [];
    let stillOwned = true;
    try {
      await recheckCuratedFixtureOwnership(owned);
    } catch (error) {
      stillOwned = false;
      failures.push(error);
    }
    try {
      await inspector.end();
    } catch (error) {
      failures.push(error);
    }
    if (created && stillOwned)
      try {
        const deadline = Date.now() + 10000;
        for (;;) {
          const count = (
            await admin.query(
              'select count(*)::int count from pg_stat_activity where datname=$1',
              [name],
            )
          ).rows[0].count;
          if (count === 0) break;
          if (Date.now() > deadline)
            throw new Error('Owned cutover database still has clients');
          await admin.query('select pg_sleep(0.02)');
        }
        await admin.query(`drop database "${name}"`);
        created = false;
        if (
          (
            await admin.query(
              'select datname from pg_database where datname=$1 union all select datname from pg_stat_activity where datname=$1',
              [name],
            )
          ).rows.length
        )
          throw new Error('Cutover DB cleanup incomplete');
      } catch (error) {
        failures.push(error);
      }
    if (acquired && stillOwned)
      try {
        const removed = await redis.eval(
          "if redis.call('GET',KEYS[1])~=ARGV[1] then return redis.error_reply('owner fence mismatch') end; local keys=redis.call('KEYS','*'); for _,key in ipairs(keys) do if key~=KEYS[1] and string.sub(key,1,17)~='pertexo:abuse:v1:' then return redis.error_reply('unexpected owned namespace key') end end; for _,key in ipairs(keys) do redis.call('DEL',key) end; return #keys",
          1,
          lease,
          token,
        );
        if ((await redis.dbsize()) !== 0)
          throw new Error('Cutover Redis DB12 cleanup incomplete');
        console.info('Owned cutover cleanup', {
          database: name,
          databaseRemoved: true,
          connections: 0,
          redisDb: 12,
          tokenFencedKeysRemoved: removed,
          redisKeys: 0,
        });
        acquired = false;
      } catch (error) {
        failures.push(error);
      }
    try {
      await redis.quit();
    } catch (error) {
      failures.push(error);
      redis.disconnect();
    }
    try {
      await admin.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(failures, 'Owned cutover cleanup failed');
  }
  try {
    await redis.connect();
    acquired =
      (await redis.eval(
        "if redis.call('DBSIZE')~=0 then return 0 end; redis.call('SET',KEYS[1],ARGV[1]); return 1",
        1,
        lease,
        token,
      )) === 1;
    if (!acquired)
      throw new Error(
        'Owned cutover Redis DB12 is not empty; refuse acquisition',
      );
    await admin.query(`create database "${name}" owner pertexo_owner`);
    created = true;
    await admin.query(`revoke all on database "${name}" from public`);
    await admin.query(
      `grant connect on database "${name}" to pertexo_api,pertexo_migration,pertexo_worker`,
    );
    return { name, apiUrl, migrationUrl, redisUrl, inspector, close };
  } catch (error) {
    await close();
    throw error;
  }
}
