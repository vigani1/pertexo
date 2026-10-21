import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callbackWaitConfigSchema } from '@pertexo/workflow-model';
import { verifyWorkerCallbacks } from '../../../../src/runtime/startup/verify-callbacks.js';
import {
  accept,
  edge,
  fixture,
  node,
  publishGraph,
  runtime,
} from '../../calls/fixtures.js';
import { callbackResources } from './fixtures.js';

const callbacks = {
  origin: 'https://example.test',
  keys: {
    current: { version: '1', key: Buffer.alloc(32, 71).toString('base64url') },
    previous: [],
  },
};

describe.runIf(fixture.enabled)('live callback startup keys', () => {
  beforeAll(fixture.setup, 60_000);
  afterAll(fixture.restoreServicesAndClose);
  it('refuses wrong or missing live keys and permits retirement after consumption despite retained history', async () => {
    const published = await publishGraph({
      settings: { maxRunDurationMs: 60_000 },
      nodes: [
        node('manual', 'core.manual'),
        {
          ...node('wait', 'core.wait'),
          config: callbackWaitConfigSchema.parse({
            mode: 'callback',
            timeoutSeconds: 60,
          }),
        },
      ],
      edges: [edge('manual', 'wait')],
    });
    const run = await accept(published);
    const resources = callbackResources();
    const workers = await runtime(undefined, resources.capabilities);
    const database = resources.config;
    const missing = {
      ...callbacks,
      keys: {
        current: {
          version: '2',
          key: Buffer.alloc(32, 72).toString('base64url'),
        },
        previous: [],
      },
    };
    const wrong = {
      ...callbacks,
      keys: {
        current: {
          version: '1',
          key: Buffer.alloc(32, 72).toString('base64url'),
        },
        previous: [],
      },
    };
    try {
      let id = '';
      await workers.until(async () => {
        const tasks = await fixture.workerQuery<{ id: string }>(
          "select id from app.pending_run_tasks where workspace_id=$1 and status='pending'",
          [fixture.workspaceId],
        );
        expect(tasks).toHaveLength(1);
        id = tasks[0]?.id ?? '';
      });
      await workers.pause();
      await expect(
        verifyWorkerCallbacks({ database, callbacks: wrong }),
      ).rejects.toThrow('does not match');
      await expect(
        verifyWorkerCallbacks({ database, callbacks: missing }),
      ).rejects.toThrow(/version/iu);
      await expect(verifyWorkerCallbacks({ database })).rejects.toThrow(
        'CALLBACK_TOKEN_KEY',
      );
      await fixture.ownerQuery(
        `insert into app.pending_run_tasks(id,workspace_id,run_id,workflow_version_id,invocation_key,kind,config,status,callback_node_id,callback_scope,callback_scope_hash,callback_token_hash,callback_key_version,completed_at,consumed_at)
        select uuidv7(),source.workspace_id,source.run_id,source.workflow_version_id,'history:'||n,'callback',source.config,'canceled','history-'||n,'[]',source.callback_scope_hash,encode(sha256(n::text::bytea),'hex'),'retired',clock_timestamp(),clock_timestamp()
        from app.pending_run_tasks source cross join generate_series(1,10000) n where source.id=$1`,
        [id],
      );
      await expect(
        verifyWorkerCallbacks({ database, callbacks }),
      ).resolves.toBeUndefined();
      const identity = await resources.store.resolve(
        (
          await fixture.workerQuery<{ callback_token_hash: string }>(
            'select callback_token_hash from app.pending_run_tasks where id=$1',
            [id],
          )
        )[0]?.callback_token_hash ?? '',
        AbortSignal.timeout(5_000),
      );
      if (identity === null) throw new Error('Missing callback');
      await resources.store.respond({
        callback: identity,
        output: { body: 'done', headers: {} },
        redactOutput: (value) => value,
        signal: AbortSignal.timeout(5_000),
      });
      await expect(
        verifyWorkerCallbacks({ database, callbacks: missing }),
      ).rejects.toThrow(/version/iu);
      await workers.restart();
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            'select status from app.workflow_runs where id=$1',
            [run.runId],
          ),
        ).toEqual([{ status: 'succeeded' }]);
      });
      await expect(
        verifyWorkerCallbacks({ database, callbacks: missing }),
      ).resolves.toBeUndefined();
    } finally {
      await workers.close();
      await resources.close();
    }
  }, 40_000);
});
