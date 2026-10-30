import { describe, expect, it } from 'vitest';

import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  parseCheckpoint,
  parseWorkflowExecutable,
} from '../src/index.js';
import { graph, nodeCatalog } from './support/executable-workflow.js';

// Each serialized boundary accepts exactly its own fields and reports a
// mismatch with its own error code.
const workflowVersionId = '00000000-0000-4000-8000-000000000001';
const catalog = composeExecutableCatalog(nodeCatalog());
const executable = buildWorkflowExecutable({ graph: graph(), catalog });
const checkpoint = () =>
  JSON.parse(
    JSON.stringify(
      createCheckpoint({ workflowVersionId, iterationBudget: 10 }),
    ),
  ) as Record<string, unknown>;

describe('checkpoint fields', () => {
  it('refuses an unknown field', () => {
    expect(() => parseCheckpoint({ ...checkpoint(), extra: 1 })).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );
  });

  it('refuses a missing field', () => {
    const { invocations, ...missing } = checkpoint();
    expect(invocations).toEqual([]);
    expect(() => parseCheckpoint(missing)).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );
  });

  it('refuses a field backed by a getter', () => {
    const { invocations, ...rest } = checkpoint();
    const withGetter = Object.defineProperty(rest, 'invocations', {
      enumerable: true,
      get: () => invocations,
    });
    expect(() => parseCheckpoint(withGetter)).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );
  });
});

describe('executable envelope fields', () => {
  const envelope = () =>
    JSON.parse(JSON.stringify(executable.envelope)) as Record<string, unknown>;

  it('reads back its own envelope', () => {
    expect(() =>
      parseWorkflowExecutable({ envelope: envelope(), catalog }),
    ).not.toThrow();
  });

  it('refuses an unknown field', () => {
    expect(() =>
      parseWorkflowExecutable({
        envelope: { ...envelope(), extra: 1 },
        catalog,
      }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });

  it('refuses a missing field', () => {
    const { runtimePolicies, ...missing } = envelope();
    expect(runtimePolicies).toBeDefined();
    expect(() =>
      parseWorkflowExecutable({ envelope: missing, catalog }),
    ).toThrow(expect.objectContaining({ code: 'executable_invalid' }));
  });
});

describe('observation fields', () => {
  const advance = (observations: unknown) =>
    advanceWorkflow({
      runId: 'field-set-run',
      executable,
      workflowVersionId,
      checkpoint: checkpoint(),
      observations,
      occurredAt: '2026-10-30T00:00:01.000Z',
      maximumAdmissions: 1,
      signal: new AbortController().signal,
    });

  it('accepts its own fields', async () => {
    await expect(
      advance([
        { kind: 'deadline_expired', occurredAt: '2026-10-30T00:00:00.000Z' },
      ]),
    ).resolves.toMatchObject({ checkpoint: { runStatus: 'timed_out' } });
  });

  it('refuses an unknown field', async () => {
    await expect(
      advance([
        {
          kind: 'deadline_expired',
          occurredAt: '2026-10-30T00:00:00.000Z',
          extra: 1,
        },
      ]),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
  });

  it('refuses a missing field', async () => {
    await expect(advance([{ kind: 'deadline_expired' }])).rejects.toMatchObject(
      { code: 'observation_invalid' },
    );
  });
});
