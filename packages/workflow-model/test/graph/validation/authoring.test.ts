import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTHORING_VALIDATION_BUDGET,
  AuthoringValidationUnavailableError,
  type WorkflowExpressionPolicyProjection,
} from '../../../src/authoring-validation/contracts.js';
import { WorkflowAuthoringValidator } from '../../../src/authoring-validation/validator.js';
import { parseWorkflowGraphDraft } from '../../../src/graph/validation/preflight.js';
import { validateWorkflowGraph } from '../../../src/graph/validation/index.js';
import * as policy from '../../../src/expressions/policy.js';
import { validateAuthoringBatch } from '../../../src/authoring-validation/validation.js';

const policies: WorkflowExpressionPolicyProjection = {
  definitions: [
    {
      definition: { key: 'core.set', version: 1 },
      policyReferences: [{ key: 'jsonata.restricted', version: 1 }],
    },
    {
      definition: { key: 'core.foreach', version: 1 },
      policyReferences: [{ key: 'jsonata.restricted', version: 1 }],
    },
  ],
};
const graph = (expression = 'runInput.amount > 5000') => ({
  schemaVersion: 1,
  nodes: [
    {
      id: 'step',
      definition: { key: 'core.set', version: 1 },
      position: { x: 0, y: 0 },
      configVersion: 1,
      config: { opaque: 'credential-must-not-leak' },
      connectionRefs: {},
      inputMappings: {
        result: {
          kind: 'expression',
          language: 'jsonata',
          policyVersion: 1,
          expression,
        },
      },
    },
  ],
  edges: [],
  settings: {},
});
const valid = {
  ok: true,
  issues: [],
  expandedInvocations: 1,
  worstCaseLoopIterations: 0,
};

class ControlledWorker extends EventEmitter {
  messages: unknown[] = [];
  terminateCalls = 0;
  terminateMode: 'exit' | 'reject' | 'pending' | 'resolved_without_exit' =
    'exit';
  postMessage(message: unknown): void {
    this.messages.push(message);
  }
  terminate(): Promise<number> {
    this.terminateCalls += 1;
    if (this.terminateMode === 'reject')
      return Promise.reject(new Error('credential-must-not-leak'));
    if (this.terminateMode === 'pending') return new Promise(() => undefined);
    if (this.terminateMode === 'resolved_without_exit')
      return Promise.resolve(1);
    this.emit('exit', 1);
    return Promise.resolve(1);
  }
  asWorker(): Worker {
    return this as unknown as Worker;
  }
  succeed(): void {
    this.emit('message', { kind: 'ready' });
    const message = this.messages[0];
    if (message === null || typeof message !== 'object')
      throw new Error('Missing controlled batch');
    const id: unknown = Reflect.get(message, 'id');
    if (typeof id !== 'number') throw new Error('Missing batch identity');
    this.emit('message', { kind: 'started', id });
    this.emit('message', { kind: 'result', id, report: valid });
  }
}
const owners: WorkflowAuthoringValidator[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(owners.splice(0).map((owner) => owner.shutdown()));
  vi.restoreAllMocks();
});
function createOwner(
  options: ConstructorParameters<typeof WorkflowAuthoringValidator>[0] = {},
) {
  const owner = new WorkflowAuthoringValidator(options);
  owners.push(owner);
  return owner;
}
function controlled(
  options: ConstructorParameters<typeof WorkflowAuthoringValidator>[0] = {},
) {
  const workers: ControlledWorker[] = [];
  const owner = createOwner({
    ...options,
    maxActive: 1,
    workerFactory: () => {
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker.asWorker();
    },
  });
  return { owner, workers };
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing test resource');
  return value;
}

describe('authoring admission through real compiled workers', () => {
  it('parses without evaluating, exposes safe mapping findings and never changes draft data', async () => {
    const owner = createOwner();
    const input = graph();
    const original = JSON.stringify(input);
    expect(await owner.validate(input, policies)).toMatchObject({
      ok: true,
      issues: [],
    });
    expect(JSON.stringify(input)).toBe(original);
    // A valid but expensive execution is only parsed, never run.
    expect(
      await owner.validate(graph('$distinct([1..50000])'), policies),
    ).toMatchObject({ ok: true });
    const invalid = await owner.validate(
      graph('runInput.credential-must-not-leak.'),
      policies,
    );
    expect(invalid).toMatchObject({
      ok: false,
      issues: [
        {
          code: 'invalid_expression',
          path: '$.nodes.step.inputMappings.result',
        },
      ],
    });
    expect(JSON.stringify(invalid)).not.toContain('credential-must-not-leak');
    expect(JSON.stringify(owner.diagnostics())).not.toMatch(
      /expression|config|credential|AST/u,
    );
    expect(await owner.validate(graph('$now()'), policies)).toMatchObject({
      ok: false,
      issues: [
        {
          message:
            'This expression uses a construct unavailable in the pinned policy.',
        },
      ],
    });
    expect(owner.diagnostics().active).toBe(0);
  });

  it('checks exact definition pins and nested body paths', async () => {
    const owner = createOwner();
    const body = {
      ...graph('runInput.'),
      inputPorts: ['item', 'ordinal'],
      outputPorts: ['result'],
    };
    const nested = graph();
    const loop = {
      ...required(nested.nodes[0]),
      id: 'loop',
      definition: { key: 'core.foreach', version: 1 },
      inputMappings: {},
      structured: {
        kind: 'for_each',
        maxIterations: 1,
        maxConcurrency: 1,
        body,
      },
    };
    expect(
      await owner.validate({ ...nested, nodes: [loop] }, policies),
    ).toMatchObject({
      ok: false,
      issues: [
        {
          path: '$.nodes.loop.structured.body.nodes.step.inputMappings.result',
        },
      ],
    });
    const noPin = {
      ...policies,
      definitions: [
        { definition: { key: 'core.set', version: 1 }, policyReferences: [] },
      ],
    };
    expect(await owner.validate(graph(), noPin)).toMatchObject({
      ok: false,
      issues: [
        {
          message:
            'The expression policy is not available for this step definition.',
        },
      ],
    });
    const futurePin = {
      ...noPin,
      definitions: [
        {
          definition: { key: 'core.set', version: 1 },
          policyReferences: [{ key: 'jsonata.restricted', version: 2 }],
        },
      ],
    };
    const futureNode = required(graph().nodes[0]);
    expect(
      await owner.validate(
        {
          ...graph(),
          nodes: [
            {
              ...futureNode,
              inputMappings: {
                result: {
                  ...futureNode.inputMappings.result,
                  policyVersion: 2,
                },
              },
            },
          ],
        },
        futurePin,
      ),
    ).toMatchObject({
      ok: false,
      issues: [
        {
          message:
            'The expression policy is not available for this step definition.',
        },
      ],
    });
    await expect(
      owner.validate(graph(), {
        ...policies,
        definitions: [
          required(policies.definitions[0]),
          required(policies.definitions[0]),
        ],
      }),
    ).rejects.toMatchObject({ reason: 'invalid_policy_projection' });
  });

  it('retains existing exact/over language limits and the public graph envelope', async () => {
    const owner = createOwner();
    for (const source of [
      '1' + ' '.repeat(16_383),
      Array(64).fill('1').join('+'),
      '[' + Array(2047).fill('1').join(',') + ']',
    ])
      expect(await owner.validate(graph(source), policies)).toMatchObject({
        ok: true,
      });
    for (const source of [
      '1' + ' '.repeat(16_384),
      Array(65).fill('1').join('+'),
      '[' + Array(2048).fill('1').join(',') + ']',
    ])
      expect(await owner.validate(graph(source), policies)).toMatchObject({
        ok: false,
        issues: [{ code: 'invalid_expression' }],
      });
    const many = graph();
    required(many.nodes[0]).inputMappings = Object.fromEntries(
      Array.from({ length: 5000 }, (_, i) => [
        'f' + String(i),
        {
          kind: 'expression',
          language: 'jsonata',
          policyVersion: 1,
          expression: 'runInput.v + ' + String(i),
        },
      ]),
    ) as (typeof many.nodes)[0]['inputMappings'];
    expect(await owner.validate(many, policies)).toMatchObject({ ok: true });
    await expect(
      owner.validate(
        { ...graph(), settings: { secret: 'x'.repeat(1_048_576) } },
        policies,
      ),
    ).rejects.toBeTruthy();
  });
});

describe('bounded authoring worker ownership', () => {
  it.each(['canceled', 'closed'] as const)(
    'keeps %s authoritative after a result while termination is pending',
    async (reason) => {
      const { owner, workers } = controlled();
      const signal = new AbortController();
      const request = owner.validate(graph(), policies, {
        signal: signal.signal,
      });
      const assertion = expect(request).rejects.toMatchObject({ reason });
      const worker = required(workers[0]);
      worker.terminateMode = 'resolved_without_exit';
      worker.succeed();
      await Promise.resolve();
      expect(owner.diagnostics().active).toBe(1);
      let shutdown: Promise<void> | undefined;
      if (reason === 'canceled') signal.abort();
      else shutdown = owner.shutdown();
      worker.emit('exit', 1);
      await assertion;
      await shutdown;
      expect(worker.terminateCalls).toBe(1);
      expect(owner.diagnostics().active).toBe(0);
    },
  );

  it('does not rewrite an already settled successful outcome', async () => {
    const { owner, workers } = controlled();
    const signal = new AbortController();
    const request = owner.validate(graph(), policies, {
      signal: signal.signal,
    });
    required(workers[0]).succeed();
    const report = await request;
    signal.abort();
    await owner.shutdown();
    expect(await request).toBe(report);
  });

  it('honors shutdown after observed exit but before caller settlement', async () => {
    const { owner, workers } = controlled();
    const request = owner.validate(graph(), policies);
    const assertion = expect(request).rejects.toMatchObject({
      reason: 'closed',
    });
    const worker = required(workers[0]);
    worker.terminateMode = 'resolved_without_exit';
    worker.succeed();
    worker.emit('exit', 1);
    expect(owner.diagnostics().active).toBe(0);
    await owner.shutdown();
    await assertion;
  });

  it('drains successful batches in FIFO order and releases payload accounting', async () => {
    const { owner, workers } = controlled();
    const first = owner.validate(graph('1'), policies);
    const second = owner.validate(graph('2'), policies);
    const third = owner.validate(graph('3'), policies);
    expect(workers).toHaveLength(1);
    required(workers[0]).succeed();
    await first;
    expect(required(workers[1]).messages).toHaveLength(0);
    required(workers[1]).succeed();
    await second;
    expect(required(workers[1]).messages[0]).toMatchObject({
      graph: { nodes: [{ inputMappings: { result: { expression: '2' } } }] },
    });
    required(workers[2]).succeed();
    await third;
    expect(required(workers[2]).messages[0]).toMatchObject({
      graph: { nodes: [{ inputMappings: { result: { expression: '3' } } }] },
    });
    expect(owner.diagnostics()).toMatchObject({
      active: 0,
      queued: 0,
      queuedBytes: 0,
    });
  });

  it('does not dispatch expired queued work even when its timer has not run', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const { owner, workers } = controlled({ queueMs: 20 });
    const first = owner.validate(graph(), policies);
    const queued = owner.validate(graph(), policies);
    const assertion = expect(queued).rejects.toMatchObject({
      reason: 'queue_timeout',
    });
    clock.mockReturnValue(21);
    required(workers[0]).succeed();
    await first;
    await assertion;
    expect(workers).toHaveLength(1);
    expect(owner.diagnostics()).toMatchObject({ queued: 0, queuedBytes: 0 });
  });

  it('caps serialized policy payloads before worker creation', async () => {
    const { owner, workers } = controlled();
    await expect(
      owner.validate(graph(), {
        definitions: [
          ...policies.definitions,
          {
            definition: {
              key: 'x'.repeat(AUTHORING_VALIDATION_BUDGET.envelopeBytes),
              version: 1,
            },
            policyReferences: [],
          },
        ],
      }),
    ).rejects.toMatchObject({ reason: 'payload_limit' });
    expect(workers).toHaveLength(0);
  });

  it('handles construction and dispatch failures without leaking exceptions', async () => {
    const factoryFailure = createOwner({
      workerFactory: () => {
        throw new Error('credential-must-not-leak');
      },
    });
    await expect(
      factoryFailure.validate(graph(), policies),
    ).rejects.toMatchObject({
      reason: 'worker_failed',
      message: 'Workflow validation is temporarily unavailable.',
    });
    expect(factoryFailure.diagnostics().active).toBe(0);
    const { owner, workers } = controlled();
    const request = owner.validate(graph(), policies);
    vi.spyOn(required(workers[0]), 'postMessage').mockImplementation(() => {
      throw new Error('credential-must-not-leak');
    });
    required(workers[0]).emit('message', { kind: 'ready' });
    await expect(request).rejects.toMatchObject({ reason: 'invalid_response' });
    expect(owner.diagnostics().active).toBe(0);
  });

  it('fails unexpected exit and still drains a waiting batch', async () => {
    const { owner, workers } = controlled();
    const first = owner.validate(graph(), policies);
    const firstError = expect(first).rejects.toMatchObject({
      reason: 'worker_failed',
    });
    const queued = owner.validate(graph(), policies);
    required(workers[0]).emit('exit', 2);
    await firstError;
    required(workers[1]).succeed();
    await queued;
    expect(owner.diagnostics()).toMatchObject({
      active: 0,
      queued: 0,
      queuedBytes: 0,
    });
  });

  it.each([
    'duplicate_ready',
    'wrong_id',
    'duplicate_started',
    'AST_in_report',
  ] as const)(
    'rejects invalid protocol %s without releasing an unobserved worker',
    async (kind) => {
      const { owner, workers } = controlled();
      const request = owner.validate(graph(), policies);
      const worker = required(workers[0]);
      worker.emit('message', { kind: 'ready' });
      if (kind === 'duplicate_ready') worker.emit('message', { kind: 'ready' });
      else if (kind === 'wrong_id')
        worker.emit('message', { kind: 'started', id: 999 });
      else {
        worker.emit('message', { kind: 'started', id: 1 });
        if (kind === 'duplicate_started')
          worker.emit('message', { kind: 'started', id: 1 });
        else
          worker.emit('message', {
            kind: 'result',
            id: 1,
            report: { ...valid, ast: 'credential-must-not-leak' },
          });
      }
      await expect(request).rejects.toMatchObject({
        reason: 'invalid_response',
      });
      expect(worker.terminateCalls).toBe(1);
      expect(owner.diagnostics().active).toBe(0);
    },
  );

  it.each(['message', 'bytes'] as const)(
    'enforces report %s budgets in the owner',
    async (limit) => {
      const { owner, workers } = controlled();
      const request = owner.validate(graph(), policies);
      const worker = required(workers[0]);
      worker.emit('message', { kind: 'ready' });
      worker.emit('message', { kind: 'started', id: 1 });
      worker.emit('message', {
        kind: 'result',
        id: 1,
        report: {
          ...valid,
          ok: false,
          issues: [
            {
              code: 'invalid_expression',
              path:
                limit === 'bytes'
                  ? 'x'.repeat(AUTHORING_VALIDATION_BUDGET.reportBytes + 257)
                  : '$.nodes.step',
              message:
                limit === 'message'
                  ? 'x'.repeat(AUTHORING_VALIDATION_BUDGET.messageBytes + 1)
                  : 'Invalid expression.',
            },
          ],
        },
      });
      await expect(request).rejects.toMatchObject({ reason: 'report_limit' });
      expect(owner.diagnostics().active).toBe(0);
    },
  );

  it('fails shutdown if exit cannot be confirmed and keeps the owner closed', async () => {
    vi.useFakeTimers();
    const worker = new ControlledWorker();
    worker.terminateMode = 'pending';
    // Expected failing shutdown is fully handled here, not by successful-owner teardown.
    const owner = new WorkflowAuthoringValidator({
      terminationMs: 20,
      workerFactory: () => worker.asWorker(),
    });
    const request = owner.validate(graph(), policies);
    const requestError = expect(request).rejects.toMatchObject({
      reason: 'termination_failed',
    });
    const shutdown = owner.shutdown();
    const shutdownError = expect(shutdown).rejects.toMatchObject({
      reason: 'termination_failed',
    });
    await vi.advanceTimersByTimeAsync(20);
    await requestError;
    await shutdownError;
    expect(owner.shutdown()).toBe(shutdown);
    expect(owner.diagnostics()).toMatchObject({ active: 1, closed: true });
    await expect(owner.validate(graph(), policies)).rejects.toMatchObject({
      reason: 'closed',
    });
    worker.emit('exit', 1);
    expect(owner.diagnostics().active).toBe(0);
  });

  it('bounds queue count, tracks bytes, and removes canceled queued payloads', async () => {
    const { owner, workers } = controlled({ maxQueued: 1 });
    const active = owner.validate(graph(), policies);
    const signal = new AbortController();
    const queued = owner.validate(graph(), policies, { signal: signal.signal });
    const assertion = expect(queued).rejects.toMatchObject({
      reason: 'canceled',
    });
    expect(owner.diagnostics()).toMatchObject({ active: 1, queued: 1 });
    expect(owner.diagnostics().queuedBytes).toBeGreaterThan(0);
    await expect(owner.validate(graph(), policies)).rejects.toMatchObject({
      reason: 'overloaded',
    });
    signal.abort();
    await assertion;
    expect(owner.diagnostics()).toMatchObject({ queued: 0, queuedBytes: 0 });
    required(workers[0]).succeed();
    await active;
  });

  it('enforces queued bytes separately and never starts aborted work', async () => {
    const { owner, workers } = controlled({ maxQueuedBytes: 1 });
    const active = owner.validate(graph(), policies);
    await expect(owner.validate(graph(), policies)).rejects.toMatchObject({
      reason: 'overloaded',
    });
    const abort = new AbortController();
    abort.abort();
    await expect(
      owner.validate(graph(), policies, { signal: abort.signal }),
    ).rejects.toMatchObject({ reason: 'canceled' });
    expect(workers).toHaveLength(1);
    required(workers[0]).succeed();
    await active;
  });

  it.each(['queue_timeout', 'startup_timeout', 'parse_timeout'] as const)(
    'bounds %s and clears retained queue accounting',
    async (reason) => {
      vi.useFakeTimers();
      const { owner, workers } = controlled({
        queueMs: 20,
        startupMs: 40,
        parseMs: 20,
      });
      const first = owner.validate(graph(), policies);
      let request = first;
      if (reason === 'queue_timeout')
        request = owner.validate(graph(), policies);
      if (reason === 'parse_timeout')
        required(workers[0]).emit('message', { kind: 'ready' });
      const assertion = expect(request).rejects.toMatchObject({ reason });
      await vi.advanceTimersByTimeAsync(reason === 'startup_timeout' ? 40 : 20);
      await assertion;
      if (reason === 'queue_timeout') {
        required(workers[0]).succeed();
        await first;
      }
      expect(owner.diagnostics()).toMatchObject({
        active: 0,
        queued: 0,
        queuedBytes: 0,
      });
    },
  );

  it.each(['reject', 'pending', 'resolved_without_exit'] as const)(
    'quarantines termination %s and fences late results',
    async (mode) => {
      vi.useFakeTimers();
      const { owner, workers } = controlled({
        terminationMs: 20,
        maxQueued: 0,
      });
      const signal = new AbortController();
      const request = owner.validate(graph(), policies, {
        signal: signal.signal,
      });
      const worker = required(workers[0]);
      worker.terminateMode = mode;
      const assertion = expect(request).rejects.toMatchObject({
        reason: 'termination_failed',
      });
      signal.abort();
      await vi.advanceTimersByTimeAsync(20);
      await assertion;
      worker.emit('message', { kind: 'result', id: 1, report: valid });
      expect(owner.diagnostics().active).toBe(1);
      await expect(owner.validate(graph(), policies)).rejects.toMatchObject({
        reason: 'overloaded',
      });
      expect(worker.terminateCalls).toBe(1);
      // Explicit confirmation releases this controlled (not OS) test resource.
      worker.emit('exit', 1);
      expect(owner.diagnostics().active).toBe(0);
    },
  );

  it('memoizes shutdown, aborts active/queued jobs and rejects late successes', async () => {
    const { owner, workers } = controlled();
    const active = owner.validate(graph(), policies);
    const queued = owner.validate(graph(), policies);
    const activeError = expect(active).rejects.toMatchObject({
      reason: 'closed',
    });
    const queuedError = expect(queued).rejects.toMatchObject({
      reason: 'closed',
    });
    const shutdown = owner.shutdown();
    expect(owner.shutdown()).toBe(shutdown);
    await shutdown;
    await activeError;
    await queuedError;
    expect(owner.diagnostics()).toEqual({
      active: 0,
      queued: 0,
      queuedBytes: 0,
      closed: true,
    });
    required(workers[0]).emit('message', {
      kind: 'result',
      id: 1,
      report: valid,
    });
    await expect(owner.validate(graph(), policies)).rejects.toMatchObject({
      reason: 'closed',
    });
  });

  it('rejects worker protocol errors without retaining raw exceptions or payloads', async () => {
    const { owner, workers } = controlled();
    const request = owner.validate(graph(), policies);
    required(workers[0]).emit('error', new Error('credential-must-not-leak'));
    const result = await request.catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AuthoringValidationUnavailableError);
    expect(result).toMatchObject({ reason: 'worker_failed' });
    expect(JSON.stringify(result)).not.toContain('credential-must-not-leak');
    expect(String(result)).not.toContain('credential-must-not-leak');
    const malformed = owner.validate(graph(), policies);
    required(workers[1]).emit('message', {
      kind: 'result',
      id: 2,
      report: valid,
    });
    await expect(malformed).rejects.toMatchObject({
      reason: 'invalid_response',
    });
  });
});

describe('report and invocation-local policy cache', () => {
  it('keeps unrelated canonical-data failures structural rather than operational', () => {
    const candidate = parseWorkflowGraphDraft(graph());
    const report = validateAuthoringBatch(
      {
        ...candidate,
        nodes: [
          { ...required(candidate.nodes[0]), config: { invalid: Number.NaN } },
        ],
      },
      policies,
    );
    expect(report).toMatchObject({
      ok: false,
      issues: [{ code: 'invalid_graph' }],
    });
  });

  it('preserves historical structural collection and full identifiers', () => {
    const source = required(graph().nodes[0]);
    const field = (i: number) => `field${String(i)}${'k'.repeat(8_000)}`;
    const candidate = parseWorkflowGraphDraft({
      ...graph(),
      nodes: [
        {
          ...source,
          inputMappings: Object.fromEntries(
            Array.from({ length: 100 }, (_, i) => [
              field(i),
              { kind: 'node_output', nodeId: 'missing', path: '$' },
            ]),
          ),
        },
      ],
    });
    const historical = validateWorkflowGraph(candidate);
    expect(historical.ok).toBe(false);
    expect(historical.issues).toHaveLength(100);
    expect(historical.issues[0]).toEqual({
      code: 'invalid_mapping',
      path: `$.nodes.${source.id}.inputMappings.${field(0)}`,
      message: 'node output mappings must reference a direct local predecessor',
    });
    expect(Buffer.byteLength(JSON.stringify(historical))).toBeGreaterThan(
      AUTHORING_VALIDATION_BUDGET.reportBytes,
    );
  });

  it('stops structural issue amplification before a large report is accumulated', () => {
    const source = required(graph().nodes[0]);
    const candidate = parseWorkflowGraphDraft({
      ...graph(),
      nodes: [
        {
          ...source,
          inputMappings: Object.fromEntries(
            Array.from({ length: 100 }, (_, i) => [
              `field${String(i)}${'k'.repeat(8_000)}`,
              { kind: 'node_output', nodeId: 'missing', path: '$' },
            ]),
          ),
        },
      ],
    });
    const serialization = vi.spyOn(JSON, 'stringify');
    expect(() => validateAuthoringBatch(candidate, policies)).toThrow(
      AuthoringValidationUnavailableError,
    );
    const largeReportWasAccumulated = serialization.mock.calls.some((call) => {
      const input: unknown = call[0];
      return (
        input !== null &&
        typeof input === 'object' &&
        'issues' in input &&
        Array.isArray(input.issues) &&
        input.issues.length > 32
      );
    });
    expect(largeReportWasAccumulated).toBe(false);
  });

  it('returns sanitized operational exhaustion for structural amplification through a real worker', async () => {
    const owner = createOwner();
    const source = required(graph().nodes[0]);
    const candidate = {
      ...graph(),
      nodes: [
        {
          ...source,
          inputMappings: Object.fromEntries(
            Array.from({ length: 100 }, (_, i) => [
              `field${String(i)}${'k'.repeat(5_000)}`,
              { kind: 'node_output', nodeId: 'missing', path: '$' },
            ]),
          ),
        },
      ],
    };
    await expect(owner.validate(candidate, policies)).rejects.toMatchObject({
      reason: 'report_limit',
      message: 'Workflow validation is temporarily unavailable.',
    });
    expect(owner.diagnostics().active).toBe(0);
  });

  it('deduplicates within one invocation only and caps findings without claiming validity', () => {
    const spy = vi.spyOn(policy, 'validateExpression');
    const input = graph('runInput.');
    required(input.nodes[0]).inputMappings = Object.fromEntries(
      Array.from({ length: 150 }, (_, i) => [
        'f' + String(i),
        {
          kind: 'expression',
          language: 'jsonata',
          policyVersion: 1,
          expression: 'runInput.',
        },
      ]),
    ) as (typeof input.nodes)[0]['inputMappings'];
    const admitted = parseWorkflowGraphDraft(input);
    const report = validateAuthoringBatch(admitted, policies);
    expect(report.ok).toBe(false);
    expect(report.issues).toHaveLength(100);
    expect(spy).toHaveBeenCalledTimes(1);
    validateAuthoringBatch(admitted, policies);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('fails report byte overflow operationally instead of exposing source/AST or truncating paths', () => {
    const input = graph('runInput.');
    const step = required(input.nodes[0]);
    step.inputMappings = {
      ['r'.repeat(AUTHORING_VALIDATION_BUDGET.reportBytes)]:
        step.inputMappings.result,
    } as typeof step.inputMappings;
    const admitted = parseWorkflowGraphDraft(input);
    expect(() => validateAuthoringBatch(admitted, policies)).toThrow(
      AuthoringValidationUnavailableError,
    );
  });
});
