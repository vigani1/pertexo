import { writeSync } from 'node:fs';
import pg from 'pg';
import {
  advanceRun,
  createRunAdvanceStore,
  createWorkflowCallStore,
} from '@pertexo/core/runs';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { composeExecutableCatalog } from '@pertexo/workflow-engine/server';
import { nodeFailureCompletion } from '../../../../dist/attempts/delivery/executor-failure.js';
import {
  createInlineFixtureRegistry,
  inlineFixtureCatalog,
} from './registration.fixture.mjs';

const settings = JSON.parse(process.env.INLINE_COORDINATOR_FIXTURE);
const pause = (stage) => {
  writeSync(1, `inline coordinator paused: ${stage}\n`);
  process.kill(process.pid, 'SIGSTOP');
};

if (['stale-cas', 'before-commit', 'after-commit'].includes(settings.stage)) {
  const seen = new WeakSet();
  const connect = pg.Pool.prototype.connect;
  pg.Pool.prototype.connect = async function (callback) {
    if (callback !== undefined) return connect.call(this, callback);
    const client = await connect.call(this);
    if (seen.has(client)) return client;
    seen.add(client);
    let written = false;
    const query = client.query.bind(client);
    client.query = function (statement, values) {
      const source = typeof statement === 'string' ? statement : statement.text;
      const target =
        /^update "app"\."run_checkpoints"/iu.test(source) &&
        (values ?? statement.values ?? []).includes(settings.input.runId);
      // Refuse the real revision write after the earlier rows have reached PostgreSQL.
      if (target && settings.stage === 'stale-cas') {
        const refused = `${source} and false`;
        return typeof statement === 'string'
          ? query(refused, values)
          : query({ ...statement, text: refused }, values);
      }
      if (target) written = true;
      if (!written || source.trim().toLowerCase() !== 'commit')
        return query(...arguments);
      written = false;
      if (settings.stage === 'before-commit') pause('before-commit');
      return query(...arguments).then((result) => {
        pause('after-commit');
        return result;
      });
    };
    return client;
  };
}

const runs = createRunAdvanceStore(
  parseDatabaseConfig({ connectionString: settings.databaseUrl, max: 1 }),
);
const calls = createWorkflowCallStore(
  parseDatabaseConfig({
    connectionString: settings.maintenanceDatabaseUrl,
    max: 1,
  }),
);
let completed = 0;
try {
  const result = await advanceRun(
    {
      runs,
      calls,
      verification: { catalog: composeExecutableCatalog(inlineFixtureCatalog) },
      maximumAdmissions: 8,
      inline: {
        registry: createInlineFixtureRegistry(() => {
          completed += 1;
          if (settings.stage === 'after-second-kernel' && completed === 2)
            pause('after-second-kernel');
        }),
        normalizeFailure(error) {
          const failure = nodeFailureCompletion(error);
          if (failure === undefined) throw error;
          return failure;
        },
      },
    },
    { ...settings.input, signal: new AbortController().signal },
  );
  writeSync(1, `inline coordinator result: ${JSON.stringify(result)}\n`);
} finally {
  await Promise.all([runs.close(), calls.close()]);
}
