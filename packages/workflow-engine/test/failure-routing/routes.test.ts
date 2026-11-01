import { describe, expect, it } from 'vitest';

import {
  version,
  at,
  id,
  key,
  fixture,
} from '../support/failure-routing/runtime.js';

describe('failure routing through public engine transitions', () => {
  it.each(['utility.xml_malformed', 'file.create_data'])(
    'routes the definite data failure %s to the authored handler',
    async (code) => {
      const f = fixture();
      await f.step();
      await f.success('manual');
      const routed = await f.fail({
        nodeId: 'set',
        failureKind: 'failed',
        errorKind: 'configuration',
        attemptNumber: 1,
        safeErrorCode: code,
      });
      expect(routed.attempts.map((attempt) => attempt.nodeId)).toEqual([
        'handler',
      ]);
      expect(routed.failureValues).toMatchObject([
        { value: { errorKind: 'configuration', safeErrorCode: code } },
      ]);
      expect(routed.checkpoint.runStatus).toBe('running');
      await f.success('handler');
      expect((await f.success('handler-stop')).checkpoint.runStatus).toBe(
        'succeeded',
      );
    },
  );
  // M2: a revoked grant is the failure people most want an error path for.
  it.each([
    ['authentication', 'http.oauth2_not_connected'],
    ['authentication', 'http.oauth2_grant_revoked'],
    ['authentication', 'http.oauth2_client_rejected'],
    ['authentication', 'http.oauth2_token_expired'],
    ['rate_limit', 'http.oauth2_token_rate_limited'],
    ['provider', 'http.oauth2_token_endpoint_unavailable'],
    ['provider', 'http.oauth2_token_response_invalid'],
    ['provider', 'http.oauth2_refresh_busy'],
    ['configuration', 'http.oauth2_token_address_blocked'],
    ['configuration', 'http.oauth2_host_not_allowed'],
  ] as const)(
    'M2 routes %s failure %s to the handler',
    async (errorKind, code) => {
      const f = fixture();
      await f.step();
      await f.success('manual');
      const routed = await f.fail({
        nodeId: 'set',
        failureKind: 'failed',
        errorKind,
        attemptNumber: 1,
        safeErrorCode: code,
      });
      expect(routed.attempts.map((attempt) => attempt.nodeId)).toEqual([
        'handler',
      ]);
      expect(routed.failureValues).toMatchObject([
        { value: { errorKind, safeErrorCode: code } },
      ]);
      expect(routed.checkpoint.runStatus).toBe('running');
    },
  );

  it.each([
    'utility.xml_size',
    'utility.xml_depth',
    'utility.html_size',
    'utility.html_depth',
    'utility.result_too_large',
    'utility.too_many_items',
    'utility.hmac_unavailable',
    'file.create_size',
    'file.create_storage',
  ])('leaves platform and storage refusal %s unhandled', async (code) => {
    const f = fixture();
    await f.step();
    await f.success('manual');
    const failed = await f.fail({
      nodeId: 'set',
      failureKind: 'failed',
      errorKind: 'configuration',
      attemptNumber: 1,
      safeErrorCode: code,
    });
    expect(failed.attempts).toEqual([]);
    expect(failed.checkpoint.runStatus).toBe('failed');
    expect(failed.failureValues ?? []).toEqual([]);
  });
  it('keeps the source failed, skips normal continuation, selects one handler and only succeeds at its sink', async () => {
    const f = fixture();
    await f.step();
    await f.success('manual');
    const routed = await f.fail();
    expect(routed.attempts.map((a) => a.nodeId)).toEqual(['handler']);
    expect(routed.failureValues).toEqual([
      {
        entryInvocationKey: key('handler'),
        value: {
          nodeId: 'set',
          invocationKey: key('set'),
          attemptNumber: 1,
          errorKind: 'authentication',
          safeErrorCode: 'execution.authentication',
        },
      },
    ]);
    expect(
      routed.checkpoint.invocations.find((n) => n.nodeId === 'set'),
    ).toMatchObject({
      status: 'failed',
      failureHandling: {
        disposition: 'pending',
        sinkInvocationKey: key('handler-stop'),
      },
    });
    expect(
      routed.checkpoint.invocations.find((n) => n.nodeId === 'terminate')
        ?.status,
    ).toBe('skipped');
    expect(routed.checkpoint.runStatus).toBe('running');
    const duplicate = await f.step();
    expect(duplicate.failureValues).toBeUndefined();
    expect(duplicate.attempts).toEqual([]);
    await f.success('handler');
    const finished = await f.success('handler-stop');
    expect(finished.checkpoint.runStatus).toBe('succeeded');
    expect(
      finished.events.filter((e) => e.name === 'node.failure_handled'),
    ).toHaveLength(1);
    expect(
      finished.checkpoint.invocations.find((n) => n.nodeId === 'set')
        ?.failureHandling?.disposition,
    ).toBe('handled');
  });
  it('normal success never admits the handler', async () => {
    const f = fixture();
    await f.step();
    await f.success('manual');
    const normal = await f.success('set');
    expect(normal.attempts.map((a) => a.nodeId)).toEqual(['terminate']);
    expect(
      normal.checkpoint.invocations
        .filter((n) => n.nodeId.startsWith('handler'))
        .map((n) => n.status),
    ).toEqual(['skipped', 'skipped']);
    expect((await f.success('terminate')).checkpoint.runStatus).toBe(
      'succeeded',
    );
  });
  it('a failed handler remains an unhandled failed run', async () => {
    const f = fixture();
    await f.step();
    await f.success('manual');
    await f.fail();
    const failed = await f.fail({ nodeId: 'handler' });
    expect(failed.checkpoint.runStatus).toBe('failed');
    expect(failed.failureValues).toBeUndefined();
    expect(
      failed.checkpoint.invocations.find((n) => n.nodeId === 'set')
        ?.failureHandling?.disposition,
    ).toBe('pending');
  });
  it.each(['outcome_unknown', 'canceled'])(
    'does not route %s outcomes',
    async (kind) => {
      const f = fixture();
      await f.step();
      await f.success('manual');
      const stopped = await f.fail({ nodeId: 'set', failureKind: kind });
      expect(stopped.failureValues).toBeUndefined();
      expect(stopped.attempts).toEqual([]);
      expect(stopped.checkpoint.runStatus).toBe(kind);
    },
  );
  it.each([
    ['configuration', 'execution.attempt_invalid'],
    ['configuration', 'execution.table_key_conflict'],
    ['internal', 'code.runtime_error'],
  ])(
    'routes the step’s own %s failure %s to its handler',
    async (errorKind, safeErrorCode) => {
      const f = fixture();
      await f.step();
      await f.success('manual');
      const routed = await f.fail({
        nodeId: 'set',
        failureKind: 'failed',
        errorKind: errorKind,
        attemptNumber: 1,
        safeErrorCode: safeErrorCode,
      });
      expect(routed.attempts.map((a) => a.nodeId)).toEqual(['handler']);
      expect(routed.failureValues?.[0]?.value).toMatchObject({
        errorKind,
        safeErrorCode,
      });
    },
  );
  it('does not route unapproved platform/internal classification', async () => {
    const f = fixture();
    await f.step();
    await f.success('manual');
    const failed = await f.fail({
      nodeId: 'set',
      failureKind: 'failed',
      errorKind: 'internal',
    });
    expect(failed.failureValues).toBeUndefined();
    expect(failed.checkpoint.runStatus).toBe('failed');
  });
  it.each(['cancel', 'deadline'])(
    'does not select a handler after %s control',
    async (control) => {
      const f = fixture();
      await f.step();
      await f.success('manual');
      const cp = f.checkpoint();
      const failed = {
        kind: 'attempt_failure',
        occurredAt: at,
        invocationKey: key('set'),
        attemptId: id,
        attemptNumber: 1,
        failureKind: 'failed',
        errorKind: 'authentication',
        possiblyDispatched: false,
        safeErrorCode: 'execution.authentication',
      };
      const stop =
        control === 'cancel'
          ? {
              kind: 'cancel_requested',
              sequence: cp.nextEventSequence,
              occurredAt: at,
            }
          : { kind: 'deadline_expired', occurredAt: at };
      const plan = await f.step([failed, stop]);
      expect(plan.failureValues).toBeUndefined();
      expect(plan.attempts).toEqual([]);
      expect(plan.checkpoint.runStatus).toBe(
        control === 'cancel' ? 'canceled' : 'timed_out',
      );
    },
  );
  it('routes only after the final retry exhausts the existing policy', async () => {
    const f = fixture();
    await f.step();
    await f.success('manual');
    let retry = await f.fail({
      nodeId: 'set',
      failureKind: 'retry',
      errorKind: 'network',
      attemptNumber: 1,
    });
    for (let attempt = 2; attempt <= 3; attempt++) {
      const due = retry.checkpoint.invocations.find(
        (n) => n.nodeId === 'set',
      )?.resumeAt;
      if (due === undefined) throw new Error('Missing fixture retry date');
      const resumed = await f.step(
        [{ kind: 'due_at', occurredAt: due, invocationKey: key('set') }],
        due,
      );
      expect(resumed.attempts[0]).toMatchObject({
        nodeId: 'set',
        attemptNumber: attempt,
      });
      retry = await f.fail({
        nodeId: 'set',
        failureKind: 'retry',
        errorKind: 'network',
        attemptNumber: attempt,
      });
      if (attempt < 3) expect(retry.failureValues).toBeUndefined();
    }
    expect(retry.failureValues?.[0]?.value.attemptNumber).toBe(3);
    expect(retry.attempts.map((a) => a.nodeId)).toEqual(['handler']);
  });
  it('retry backoff selects neither path', async () => {
    const f = fixture();
    await f.step();
    await f.success('manual');
    const retry = await f.fail({
      nodeId: 'set',
      failureKind: 'retry',
      errorKind: 'network',
    });
    expect(
      retry.checkpoint.invocations.find((n) => n.nodeId === 'set')?.status,
    ).toBe('waiting');
    expect(retry.failureValues).toBeUndefined();
    expect(retry.attempts).toEqual([]);
  });
});
describe('handler input evidence', () => {
  it('requires exact safe failure data before executing the entry, separately from successful outputs', async () => {
    const { executeNodeAttempt } = await import('../../src/index.js');
    const f = fixture();
    const failure = {
      nodeId: 'set',
      invocationKey: key('set'),
      attemptNumber: 1,
      errorKind: 'authentication',
      safeErrorCode: 'execution.authentication',
    };
    const received: unknown[] = [];
    const input = {
      runId: id,
      nodeRunId: id,
      attemptId: id,
      executable: f.executable,
      workflowVersionId: version,
      invocationKey: key('handler'),
      nodeId: 'handler',
      runInput: null,
      completedNodeOutputs: [],
      registry: {
        execute: (request: { input: unknown }) => {
          received.push(request.input);
          return Promise.resolve({ kind: 'succeeded' as const, output: {} });
        },
      },
      signal: new AbortController().signal,
    };
    for (const sourceFailure of [
      undefined,
      { ...failure, nodeId: 'other' },
      { ...failure, invocationKey: 'other' },
      { ...failure, message: 'secret' },
    ]) {
      await expect(
        executeNodeAttempt({
          ...input,
          ...(sourceFailure === undefined ? {} : { sourceFailure }),
        }),
      ).rejects.toMatchObject({ code: 'attempt_invalid' });
    }
    expect(received).toEqual([]);
    await executeNodeAttempt({ ...input, sourceFailure: failure });
    expect(received).toEqual([{ reason: 'execution.authentication' }]);
    await expect(
      executeNodeAttempt({
        ...input,
        nodeId: 'set',
        invocationKey: key('set'),
        sourceFailure: failure,
      }),
    ).rejects.toMatchObject({ code: 'attempt_invalid' });
  });
});
