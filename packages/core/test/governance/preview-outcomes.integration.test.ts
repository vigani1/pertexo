import { afterAll, beforeAll, expect, it } from 'vitest';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { createGovernanceStore } from '../../src/governance/governance.store.js';
import { completePreviewAttempt } from '../../src/previews/attempts/complete.js';
import { markPreviewDispatched } from '../../src/previews/attempts/mark-dispatched.js';
import {
  acceptFixture,
  claimFixture,
  apiPool,
  workerPool,
  workspaceId,
  actorUserId,
} from '../previews/worker.fixture.js';

let audit: ReturnType<typeof createGovernanceStore>;
beforeAll(() => {
  audit = createGovernanceStore(
    parseDatabaseConfig({
      connectionString: apiPool.options.connectionString ?? '',
      max: 2,
    }),
  );
});
afterAll(() => audit.close());

it.each([
  'succeeded',
  'failed',
  'outcome_unknown',
  'canceled',
  'timed_out',
] as const)(
  'keeps a real step test’s %s outcome and dry-run mode in audit list and CSV',
  async (status) => {
    const dryRun =
      status === 'succeeded'
        ? ('provider_supported' as const)
        : ('not_supported' as const);
    const claimed = await claimFixture(
      await acceptFixture({ dryRun }),
      `audit-${status}`,
    );
    await markPreviewDispatched(workerPool, {
      lease: claimed.lease,
      workerId: claimed.workerId,
    });
    await completePreviewAttempt(workerPool, {
      delivery: claimed.fixture.delivery,
      lease: claimed.lease,
      workerId: claimed.workerId,
      outcome:
        status === 'succeeded'
          ? {
              status,
              output: {
                kind: 'inline',
                value: { privateOutput: 'DO_NOT_EXPORT' },
              },
            }
          : { status, safeErrorCode: 'preview.test_fixture' },
    });
    const scope = { workspaceId, actorId: actorUserId };
    const query = {
      targetId: claimed.fixture.previewRunId,
      action: 'preview.execution_terminal',
    };
    const listed = await audit.list({
      ...scope,
      query: { ...query, limit: 10 },
    });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.metadata).toMatchObject({ status, dryRun });
    let csv = '';
    await audit.exportCsv({
      ...scope,
      query,
      consume: async (chunks) => {
        for await (const chunk of chunks) csv += chunk;
      },
    });
    expect(csv).toContain(status);
    expect(csv).toContain(dryRun);
    expect(csv).not.toContain('DO_NOT_EXPORT');
  },
);
