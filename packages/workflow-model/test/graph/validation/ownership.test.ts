import { describe, expect, it, vi } from 'vitest';
import { AuthoringValidationUnavailableError } from '../../../src/authoring/validation/contracts.js';
import { WorkflowAuthoringValidator } from '../../../src/authoring/validation/validator.js';

import {
  policies,
  graph,
  valid,
  ControlledWorker,
  controlled,
  required,
} from '../../support/authoring-owner.js';
describe('bounded authoring worker ownership', () => {
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
