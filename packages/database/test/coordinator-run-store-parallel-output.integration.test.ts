import { describe, expect, it } from 'vitest';

import {
  checkpoint,
  createCoordinatorRunStore,
  databaseUrl,
  insertRun,
  parseDatabaseConfig,
  seedSucceededFact,
  ownedDeliveryStore,
  workerBaseUrl,
  workspaceA,
} from './coordinator-run-store.fixtures.js';

describe('persisted Parallel output material', () => {
  it.each([
    { branchIds: ['branch-01', 'branch-02'] },
    { branchIds: ['branch-02', 'branch-01'] },
    { branchIds: ['branch-01', 'branch-01'] },
    { branchIds: null },
    { branchIds: ['branch-01'], unexpected: true },
  ])(
    'forwards exact output %j for engine validation after reload',
    async (value) => {
      const invocationKey = 'version-a/parallel';
      const runId = await insertRun({
        status: 'running',
        schedulerState: checkpoint({
          runStatus: 'running',
          invocations: [
            {
              invocationKey,
              nodeId: 'parallel',
              status: 'running',
              attemptNumber: 1,
            },
          ],
          admittedInvocationKeys: [invocationKey],
        }),
      });
      const { attemptId } = await seedSucceededFact(runId, invocationKey, {
        kind: 'inline',
        schemaVersion: 1,
        value,
      });
      const expected = {
        kind: 'ready',
        state: {
          completedOutputs: [{ sequence: 2, attemptId, invocationKey, value }],
        },
      };
      await expect(
        ownedDeliveryStore.loadAdvanceState({
          workspaceId: workspaceA,
          runId,
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject(expected);
      const fresh = createCoordinatorRunStore(
        parseDatabaseConfig({
          connectionString: databaseUrl(workerBaseUrl),
          max: 1,
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      );
      try {
        await expect(
          fresh.loadAdvanceState({
            workspaceId: workspaceA,
            runId,
            signal: new AbortController().signal,
          }),
        ).resolves.toMatchObject(expected);
      } finally {
        await fresh.close();
      }
    },
  );
});

describe('immutable control-output selection', () => {
  it.each([
    ['condition', { selectedPort: 'true' }],
    ['switch', { selectedPort: 'case-a' }],
  ] as const)(
    'forwards %s output for engine validation',
    async (nodeId, value) => {
      const invocationKey = `version-a/${nodeId}`;
      const runId = await insertRun({
        status: 'running',
        schedulerState: checkpoint({
          runStatus: 'running',
          invocations: [
            { invocationKey, nodeId, status: 'running', attemptNumber: 1 },
          ],
          admittedInvocationKeys: [invocationKey],
        }),
      });
      const { attemptId } = await seedSucceededFact(runId, invocationKey, {
        kind: 'inline',
        schemaVersion: 1,
        value,
      });
      await expect(
        ownedDeliveryStore.loadAdvanceState({
          workspaceId: workspaceA,
          runId,
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        kind: 'ready',
        state: {
          completedOutputs: [{ sequence: 2, attemptId, invocationKey, value }],
        },
      });
    },
  );

  it.each([
    { selectedPort: 'true' },
    { branchIds: ['a', 'b'] },
    { items: ['x'], iterationCount: 1 },
  ])('does not treat ordinary output %j as a control value', async (value) => {
    const invocationKey = 'version-a/ordinary';
    const runId = await insertRun({
      status: 'running',
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey,
            nodeId: 'ordinary',
            status: 'running',
            attemptNumber: 1,
          },
        ],
        admittedInvocationKeys: [invocationKey],
      }),
    });
    await seedSucceededFact(runId, invocationKey, {
      kind: 'inline',
      schemaVersion: 1,
      value,
    });
    await expect(
      ownedDeliveryStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      kind: 'ready',
      state: { completedOutputs: [] },
    });
  });
});
