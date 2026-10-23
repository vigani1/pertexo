import { describe, expect, it, vi } from 'vitest';
import { AUTHORING_VALIDATION_BUDGET } from '../../../src/authoring/validation/contracts.js';

import {
  policies,
  graph,
  valid,
  createOwner,
  controlled,
  required,
} from '../../support/authoring-owner.js';
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
});
