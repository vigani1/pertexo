import { fork, type ChildProcess } from 'node:child_process';

import { beforeAll } from 'vitest';
import { z } from 'zod';

import { FixtureResourceOwner } from '../harness/resource-owner.js';
import { ownEditorBrowserProcess } from '../harness/process.js';

import { verifyWorkflowConcurrencyOwnership } from '../workflow-concurrency-ownership.js';
import { useBetterAuthRealApi } from '../../support/better-auth/real-api.support.js';
import { webOrigin } from './environment.js';
import { phase } from './process.js';

export function createWorkflowConcurrencyJourney() {
  const owner = new FixtureResourceOwner();

  const openBrowsers = new Set<string>();

  let opened = false,
    observed = false;

  let worker: ChildProcess;

  const scope = new AbortController();

  const pendingCommands = new Set<Promise<void>>();

  const browserBarriers: ReturnType<typeof ownEditorBrowserProcess>[] = [];

  function own(child: ChildProcess, kind: 'worker' | 'browser' | 'vite') {
    const lifetime = ownEditorBrowserProcess(child, kind, {
      browserDisposed: () => opened && openBrowsers.size === 0,
    });
    if (kind !== 'worker') browserBarriers.push(lifetime);
    return owner.acquire(kind, child, () => lifetime.close());
  }

  beforeAll(async () => {
    await verifyWorkflowConcurrencyOwnership();
    worker = own(
      fork(
        new URL(
          '../../../../worker/test/support/editor-browser/worker-process.fixture.ts',
          import.meta.url,
        ),
        [],
        {
          cwd: new URL('../../../../worker/', import.meta.url),
          execArgv: ['--import', 'tsx'],
          env: { ...process.env, EDITOR_BROWSER_CASE: 'schedule' },
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          detached: true,
        },
      ),
      'worker',
    );
    worker.on('message', (value: unknown) => {
      if (
        !z
          .object({ phase: z.literal('namespace-cleanup-request') })
          .safeParse(value).success
      )
        return;
      void verifyWorkflowConcurrencyOwnership().then(
        () => {
          if (worker.connected)
            worker.send({ phase: 'namespace-cleanup-approved' });
        },
        () => {
          if (worker.connected)
            worker.send({ phase: 'namespace-cleanup-denied' });
        },
      );
    });
    await phase(worker, 'namespace-ready');
  }, 30_000);

  const redis = new URL(process.env.REDIS_URL ?? 'redis://invalid:1/0');

  redis.pathname = '/11';

  const api = useBetterAuthRealApi('concurrency_browser', {
    publicWebOrigin: webOrigin,
    redisUrl: redis.toString(),
    afterMigration: async (databaseUrl) => {
      const ready = phase(worker, 'worker-ready');
      worker.send({
        workerUrl: databaseUrl(process.env.DATABASE_URL ?? ''),
        dispatcherUrl: databaseUrl(process.env.DATABASE_MAINTENANCE_URL ?? ''),
        apiUrl: databaseUrl(process.env.DATABASE_URL ?? ''),
        migrationUrl: databaseUrl(process.env.DATABASE_MIGRATION_URL ?? ''),
      });
      await ready;
    },
    beforeClose: async () => {
      scope.abort();
      await Promise.allSettled([...pendingCommands]);
      // A failed descendant barrier must preserve worker leases/Redis as well
      // as the database. The aggregate owner otherwise continues cleanup.
      for (const barrier of browserBarriers.toReversed()) await barrier.close();
      await owner.close();
    },
    beforeDrop: verifyWorkflowConcurrencyOwnership,
  });
  return {
    api,
    scope,
    get worker() {
      return worker;
    },
    set worker(value: typeof worker) {
      worker = value;
    },
    get observed() {
      return observed;
    },
    set observed(value: typeof observed) {
      observed = value;
    },
    get opened() {
      return opened;
    },
    set opened(value: typeof opened) {
      opened = value;
    },
    openBrowsers,
    pendingCommands,
    owner,
    own,
  };
}
