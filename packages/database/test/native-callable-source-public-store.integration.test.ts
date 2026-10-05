import { beforeAll, describe, expect, it } from 'vitest';
import { workspaceA } from './coordinator-run-store.fixtures.js';
import {
  acceptNativeFixture,
  activateNativeFixture,
  completeNativePhysical,
  createNativeCoordinatorFixtureStore,
  loadNativePlan,
} from './support/native-public-store.fixture.js';

beforeAll(activateNativeFixture, 60_000);
const value = { answer: 42 };

describe('native callable original-source reads through public stores', () => {
  it.each(['literal', 'run_input', 'node_output'] as const)(
    'reads only the authenticated %s result demand and rejects substituted identity',
    async (kind) => {
      const selector =
        kind === 'literal'
          ? { kind, value }
          : kind === 'run_input'
            ? { kind, path: '$' }
            : { kind, nodeId: 'manual', path: '$' };
      const run = await acceptNativeFixture(selector);
      const store = createNativeCoordinatorFixtureStore();
      try {
        await store.checkReadiness?.();
        const first = await loadNativePlan(run, store, 0);
        const committed = await first.commit();
        if (
          committed.kind !== 'committed' ||
          committed.admittedAttempts[0] === undefined
        )
          throw new Error('Native source physical admission missing');
        const attempt = committed.admittedAttempts[0];
        await completeNativePhysical(run.runId, attempt, value);
        const next = await loadNativePlan(run, store, 1, {
          runInput: value,
          outputs: [
            {
              invocationKey: attempt.invocationKey,
              output: { kind: 'inline', attemptId: attempt.attemptId },
              value,
            },
          ],
        });
        const owner = {
          workspaceId: workspaceA,
          runId: run.runId,
          workflowVersionId: run.versionId,
          delivery: next.delivery,
          expectedRevision: 1,
        };
        const demand = {
          expectedRevision: 1,
          resultSelector: selector,
          requiresRunInput: kind === 'run_input',
          sources:
            kind === 'node_output'
              ? [
                  {
                    nodeId: 'manual',
                    invocationKey: attempt.invocationKey,
                    output: {
                      kind: 'inline' as const,
                      attemptId: attempt.attemptId,
                    },
                  },
                ]
              : [],
        };
        if (
          store.loadCallableCompletionSources === undefined ||
          store.readCallableCompletionSource === undefined
        )
          throw new Error('Native callable source ports missing');
        const input = {
          owner,
          demand,
          signal: new AbortController().signal,
          readTimeoutMillis: 2000,
        };
        const inventory = await store.loadCallableCompletionSources(input);
        if (inventory.kind !== 'ready')
          throw new Error('Native inventory stopped');
        expect(inventory.projection.outputs).toHaveLength(
          kind === 'node_output' ? 1 : 0,
        );
        expect(inventory.projection.runInput === null).toBe(
          kind !== 'run_input',
        );
        const source =
          kind === 'run_input'
            ? inventory.projection.runInput
            : inventory.projection.outputs[0]?.valueSource;
        if (kind !== 'literal') {
          if (source === undefined || source === null)
            throw new Error('Selected original source missing');
          await expect(
            store.readCallableCompletionSource({ ...input, source }),
          ).resolves.toMatchObject({
            kind: 'ready',
            valueSource: { snapshot: { serializedValue: '{"answer":42}' } },
          });
          await expect(
            store.readCallableCompletionSource({
              ...input,
              source: {
                ...source,
                valueIdentity: {
                  ...source.valueIdentity,
                  sha256: 'f'.repeat(64),
                },
              },
            }),
          ).rejects.toBeDefined();
        }
        await expect(
          store.loadCallableCompletionSources({
            ...input,
            owner: { ...owner, expectedRevision: 0 },
          }),
        ).resolves.toMatchObject({
          kind: 'stopped',
          stop: { kind: 'stale', revision: 1 },
        });
        await expect(
          store.loadCallableCompletionSources({
            ...input,
            signal: AbortSignal.abort(),
          }),
        ).resolves.toEqual({
          kind: 'stopped',
          stop: { kind: 'context_aborted' },
        });
        // A read-only inventory and its failed substitution cannot consume the
        // canonical advance or prevent authentic result acceptance.
        await expect(next.commit()).resolves.toMatchObject({
          kind: 'committed',
          revision: 2,
        });
      } finally {
        await store.close();
      }
    },
  );
});
