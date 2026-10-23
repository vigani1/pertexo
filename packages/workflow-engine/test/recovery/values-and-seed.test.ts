import { describe, expect, it } from 'vitest';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  parseCheckpoint,
} from '../../src/index.js';
import { nodeProviderIdempotencyKey } from '../../src/attempt/derive-provider-key.js';
import { planRecovery } from '../../src/recovery/plan.js';
import { seedRecovery } from '../../src/recovery/seed.js';
import { selectRecoveryPrefix } from '../../src/recovery/select-prefix.js';
import type {
  RecoveryCandidate,
  RecoveryValues,
} from '../../src/recovery/contract.js';
import { conditional, id, linear, record, source } from './fixtures.js';
import { graph, nodeCatalog } from '../support/executable-workflow.js';

function candidate(fixture = linear()): RecoveryCandidate {
  const result = selectRecoveryPrefix(fixture);
  if (result.kind !== 'candidate')
    throw new Error(`Unexpected refusal: ${result.reason}`);
  return result;
}

function values(prefix: RecoveryCandidate): RecoveryValues {
  return {
    input: { kind: 'inline', value: { name: 'original' } },
    outputs: new Map(
      prefix.prefix.map(({ source, definition }) => {
        const value =
          definition.definition.key === 'core.condition'
            ? {
                selectedPort:
                  prefix.branchSelections.find(
                    (choice) => choice.nodeId === definition.id,
                  )?.selectedOutputPort ?? '',
              }
            : { name: 'original' };
        const stored = { kind: 'inline' as const, value };
        return [
          source.id,
          {
            node: stored,
            attempt: source.reused === undefined ? stored : undefined,
          },
        ];
      }),
    ),
  };
}

describe('retained recovery values', () => {
  it('copies the original input and owned prefix output', () => {
    const prefix = candidate();
    const plan = planRecovery(prefix, values(prefix));
    expect(plan).toMatchObject({
      kind: 'eligible',
      input: { name: 'original' },
    });
  });

  it('refuses expired input and missing values', () => {
    const prefix = candidate();
    expect(
      planRecovery(prefix, { ...values(prefix), input: { kind: 'expired' } }),
    ).toEqual({ kind: 'refused', reason: 'values_expired' });
    expect(
      planRecovery(prefix, { ...values(prefix), outputs: new Map() }),
    ).toEqual({ kind: 'refused', reason: 'values_missing' });
  });

  it('refuses mismatching ordinary node and attempt outputs', () => {
    const prefix = candidate();
    const stored = values(prefix);
    expect(
      planRecovery(prefix, {
        ...stored,
        outputs: new Map([
          [
            id(1),
            {
              node: { kind: 'inline', value: { name: 'original' } },
              attempt: { kind: 'inline', value: { name: 'different' } },
            },
          ],
        ]),
      }),
    ).toEqual({ kind: 'refused', reason: 'evidence_unavailable' });
  });

  it('refuses artifact descriptors even under ordinary JSON arrays and wrappers', () => {
    const prefix = candidate();
    const wrapped = {
      nested: [
        { kind: 'artifact', artifactId: id(500), extra: 'does not bypass' },
      ],
    };
    const inline = { kind: 'inline' as const, value: wrapped };
    expect(planRecovery(prefix, { ...values(prefix), input: inline })).toEqual({
      kind: 'refused',
      reason: 'artifact_value',
    });
    expect(
      planRecovery(prefix, {
        ...values(prefix),
        outputs: new Map([[id(1), { node: inline, attempt: inline }]]),
      }),
    ).toEqual({ kind: 'refused', reason: 'artifact_value' });
  });

  it('keeps unrelated artifactId fields as ordinary data', () => {
    const prefix = candidate();
    expect(
      planRecovery(prefix, {
        ...values(prefix),
        input: {
          kind: 'inline',
          value: { artifactId: id(500), description: 'external field' },
        },
      }),
    ).toMatchObject({ kind: 'eligible' });
  });

  it('refuses a saved Condition result that disagrees with its recorded choice', () => {
    const prefix = candidate(conditional('true'));
    const stored = values(prefix);
    const wrong = { kind: 'inline' as const, value: { selectedPort: 'false' } };
    const outputs = new Map(stored.outputs);
    outputs.set(id(2), { node: wrong, attempt: wrong });
    expect(planRecovery(prefix, { ...stored, outputs })).toEqual({
      kind: 'refused',
      reason: 'branch_evidence_unavailable',
    });
  });

  it('enforces the aggregate including input while every individual value stays small', () => {
    const base = graph();
    const nodes = [
      base.nodes[0],
      ...Array.from({ length: 5 }, (_, index) => ({
        ...base.nodes[1],
        id: `step-${String(index)}`,
      })),
      { ...base.nodes[2], inputMappings: {} },
    ];
    const executable = buildWorkflowExecutable({
      graph: {
        ...base,
        nodes,
        edges: nodes.slice(1).map((node, index) => ({
          id: `link-${String(index)}`,
          source: { nodeId: nodes[index]?.id ?? '', port: 'out' },
          target: { nodeId: node.id, port: 'in' },
        })),
      },
      catalog: composeExecutableCatalog(nodeCatalog()),
    });
    const retained = source(
      nodes.slice(0, -1).map((node, index) =>
        record(executable, {
          nodeId: node.id,
          ordinal: index + 1,
          status: node.id === 'step-4' ? 'failed' : 'succeeded',
        }),
      ),
    );
    const prefix = candidate({ executable, source: retained });
    const small = {
      kind: 'inline' as const,
      value: { padding: 'x'.repeat(200_000) },
    };
    expect(
      planRecovery(prefix, {
        input: small,
        outputs: new Map(
          prefix.prefix.map(({ source }) => [
            source.id,
            { node: small, attempt: small },
          ]),
        ),
      }),
    ).toEqual({ kind: 'refused', reason: 'reuse_bounds' });
  });
});

describe('fresh recovery seed', () => {
  it('starts a new cursor with owned references and no copied attempt or lease', () => {
    const prefix = candidate();
    const plan = planRecovery(prefix, values(prefix));
    if (plan.kind !== 'eligible') throw new Error('Expected plan');
    const seed = seedRecovery(plan, {
      runId: id(700),
      nodeRunIds: new Map([[id(1), id(900)]]),
    });
    if (seed.kind !== 'seeded') throw new Error('Expected seed');
    const checkpoint = parseCheckpoint(
      JSON.parse(JSON.stringify(seed.checkpoint)),
    );
    expect(checkpoint).toMatchObject({
      revision: 0,
      runStatus: 'queued',
      nextEventSequence: 3,
      cancelRequested: false,
      deadlineExpired: false,
    });
    expect(checkpoint.readySet).toEqual([]);
    expect(checkpoint.admittedInvocationKeys).toEqual([]);
    expect(checkpoint.invocations).toMatchObject([
      {
        nodeId: 'manual',
        attemptNumber: 0,
        output: { kind: 'reused', nodeRunId: id(900) },
      },
    ]);
    expect(checkpoint.invocations.some((node) => node.nodeId === 'set')).toBe(
      false,
    );
    expect(seed.copies[0]).toMatchObject({
      id: id(900),
      sourceNodeRunId: id(1),
      sourceRunId: prefix.source.id,
    });
  });

  it('preserves idempotent prefix classification with a fresh nondispatched key', () => {
    const executable = buildWorkflowExecutable({
      graph: graph(),
      catalog: composeExecutableCatalog(
        nodeCatalog({ setRetryClass: 'idempotent-with-key' }),
      ),
    });
    const retained = source([
      record(executable, { nodeId: 'manual', ordinal: 1, status: 'succeeded' }),
      record(executable, { nodeId: 'set', ordinal: 2, status: 'succeeded' }),
      record(executable, { nodeId: 'terminate', ordinal: 3, status: 'failed' }),
    ]);
    const prefix = candidate({ executable, source: retained });
    const plan = planRecovery(prefix, values(prefix));
    if (plan.kind !== 'eligible') throw new Error('Expected plan');
    const seed = seedRecovery(plan, {
      runId: id(700),
      nodeRunIds: new Map([
        [id(1), id(900)],
        [id(2), id(901)],
      ]),
    });
    if (seed.kind !== 'seeded') throw new Error('Expected seed');
    const copied = seed.copies.find((node) => node.nodeId === 'set');
    const definition = executable.envelope.graph.nodes.find(
      (node) => node.id === 'set',
    );
    expect(copied?.sideEffectClass).toBe('idempotent_with_key');
    expect(copied?.providerIdempotencyKey).toBe(
      nodeProviderIdempotencyKey(
        definition,
        id(700),
        copied?.invocationKey ?? '',
      ),
    );
    expect(copied?.providerIdempotencyKey).not.toBe(
      nodeProviderIdempotencyKey(
        definition,
        retained.id,
        copied?.invocationKey ?? '',
      ),
    );
  });
});
