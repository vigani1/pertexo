import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  parseWorkspaceId,
  workspaceTransactionFromClient,
} from '../src/tenant-access/workspace.js';
import { prepareWorkflowCallAdmissionPass } from '../src/execution/workflow-calls/workflow-call-coordinator-admission.js';

const id = (n: number) =>
  `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const parentDelivery = {
  outboxEventId: id(7),
  payloadChecksum: 'c'.repeat(64),
};
const releases = [
  {
    epoch: 5,
    fingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
    catalogJson: JSON.stringify({
      domain: 'pertexo.node-compatibility-release',
      schemaVersion: 1,
    }),
  },
];
const context = {
  parentRunId: id(2),
  expectedParentRevision: 3,
  parentDelivery,
};
const candidate = {
  operation: 'workflow.run.accept' as const,
  triggerType: 'workflow_call' as const,
  workflowId: id(4),
  workflowVersionId: id(5),
  engineVersion: 'engine-v3',
  initialCheckpoint: {},
  call: { ...context, invocationKey: 'call' },
};

describe('private admission delivery composition (external pg, not SQL authority proof)', () => {
  it('forwards the exact parent delivery to prelock before any candidate or capacity write', async () => {
    const statements: { text: string; values: unknown[] }[] = [];
    const unavailable = new Error('protected prelock unavailable');
    const client = {
      query: (command: { text: string }, values: unknown[]) => {
        statements.push({ text: command.text, values });
        return Promise.reject(unavailable);
      },
    } as unknown as PoolClient;
    const transaction = workspaceTransactionFromClient(
      client,
      parseWorkspaceId(id(1)),
    );
    await expect(
      prepareWorkflowCallAdmissionPass(transaction, {
        ...context,
        candidates: [candidate],
        compatibilityReleases: releases,
      }),
    ).rejects.toMatchObject({ cause: unavailable });
    expect(statements).toHaveLength(1);
    expect(statements[0]?.text).toContain('prelock_workflow_call_parent');
    expect(statements[0]?.values.slice(-2)).toEqual([
      parentDelivery.outboxEventId,
      parentDelivery.payloadChecksum,
    ]);
    expect(
      statements.some(({ text }) => /insert|savepoint|reserve/iu.test(text)),
    ).toBe(false);
  });

  it.each(['outboxEventId', 'payloadChecksum'] as const)(
    'rejects mismatched candidate %s before prelock or writes',
    async (field) => {
      const statements: string[] = [];
      const client = {
        query: (command: { text: string }) => {
          statements.push(command.text);
          return Promise.resolve({ rows: [] });
        },
      } as unknown as PoolClient;
      const transaction = workspaceTransactionFromClient(
        client,
        parseWorkspaceId(id(1)),
      );
      const wrong = {
        ...parentDelivery,
        [field]: field === 'outboxEventId' ? id(8) : 'd'.repeat(64),
      };
      await expect(
        prepareWorkflowCallAdmissionPass(transaction, {
          ...context,
          candidates: [
            {
              ...candidate,
              call: { ...candidate.call, parentDelivery: wrong },
            },
          ],
          compatibilityReleases: releases,
        }),
      ).rejects.toThrow('context is invalid');
      expect(statements).toEqual([]);
    },
  );
});
