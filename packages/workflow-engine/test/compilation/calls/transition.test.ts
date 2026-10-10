import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseCheckpoint } from '../../../src/index.js';
import {
  childOutcome,
  completion,
  declaredCall,
  occurredAt,
  target,
} from './fixtures.js';

describe('durable logical Call transitions', () => {
  it('prepares input once, waits without a timer, and exposes only the child result', async () => {
    const { run, prepared, declared } = await declaredCall();
    expect(declared.attempts).toEqual([]);
    expect(declared.callIntents).toHaveLength(1);
    expect(declared.callIntents?.[0]?.invocationKey).toBe(
      prepared.attempts[0]?.invocationKey,
    );
    expect(declared.callIntents?.[0]?.target).toEqual(target);
    expect(declared.callIntents?.[0]?.input.kind).toBe('inline');
    expect(declared.checkpoint.runStatus).toBe('waiting');
    const owner = declared.checkpoint.invocations.find(
      ({ nodeId }) => nodeId === 'call',
    );
    expect(owner).toMatchObject({
      status: 'waiting',
      waitKind: 'workflow_call',
    });
    expect(owner?.output).toBeUndefined();
    expect(owner?.resumeAt).toBeUndefined();
    expect(
      declared.events
        .filter(({ nodeId }) => nodeId === 'call')
        .map(({ name }) => name),
    ).toEqual(['node.waiting']);
    const recovered = parseCheckpoint(
      JSON.parse(JSON.stringify(declared.checkpoint)),
    );
    const waiting = await run.advance(recovered);
    expect(waiting.callIntents).toBeUndefined();
    expect(waiting.attempts).toEqual([]);
    expect(waiting.events).toEqual([]);
    expect(waiting.immediateContinuation).toBeUndefined();
    const outcome = childOutcome(waiting);
    const resumed = await run.advance(waiting.checkpoint, {
      callOutcomes: [outcome],
    });
    expect(
      resumed.checkpoint.invocations.find(({ nodeId }) => nodeId === 'call'),
    ).toMatchObject({
      status: 'succeeded',
      output: { kind: 'call', callId: outcome.callId },
    });
    expect(resumed.attempts.map(({ nodeId }) => nodeId)).toEqual(['terminate']);
    const duplicate = await run.advance(resumed.checkpoint, {
      callOutcomes: [outcome],
    });
    expect(duplicate.attempts).toEqual([]);
    expect(duplicate.events).toEqual([]);
    expect(duplicate.callIntents).toBeUndefined();
    const finished = await run.advance(
      duplicate.checkpoint,
      completion(resumed),
    );
    expect(finished.checkpoint.runStatus).toBe('succeeded');
  });

  it.each(['failed', 'canceled', 'timed_out', 'refused'] as const)(
    'fails the required Call for a %s child, without changing the parent to that child status',
    async (status) => {
      const { run, declared } = await declaredCall();
      const failed = await run.advance(declared.checkpoint, {
        callOutcomes: [childOutcome(declared, status)],
      });
      expect(
        failed.checkpoint.invocations.find(({ nodeId }) => nodeId === 'call')
          ?.status,
      ).toBe('failed');
      expect(failed.events).toContainEqual(
        expect.objectContaining({
          name: 'node.failed',
          reasonCode: `call_child_${status}`,
        }),
      );
      expect(failed.callIntents).toBeUndefined();
      expect(failed.attempts).toEqual([]);
      expect(failed.checkpoint.runStatus).toBe('failed');
    },
  );

  it('propagates a child unknown outcome through ordinary failure rules', async () => {
    const { run, declared } = await declaredCall();
    const unknown = await run.advance(declared.checkpoint, {
      callOutcomes: [childOutcome(declared, 'outcome_unknown')],
    });
    expect(unknown.checkpoint.runStatus).toBe('outcome_unknown');
    expect(unknown.attempts).toEqual([]);
  });

  it.each(['cancel_requested', 'deadline_expired'] as const)(
    'preserves the parent’s own %s and ignores a late child result',
    async (kind) => {
      const { run, declared } = await declaredCall();
      const fact = childOutcome(declared);
      const stopped = await run.advance(declared.checkpoint, {
        observations: [
          {
            kind,
            occurredAt,
            ...(kind === 'cancel_requested'
              ? { sequence: declared.checkpoint.nextEventSequence }
              : {}),
          },
        ],
      });
      expect(stopped.checkpoint.runStatus).toBe(
        kind === 'cancel_requested' ? 'canceled' : 'timed_out',
      );
      const late = await run.advance(stopped.checkpoint, {
        callOutcomes: [fact],
      });
      expect(late.checkpoint.runStatus).toBe(stopped.checkpoint.runStatus);
      expect(late.events).toEqual([]);
      expect(late.attempts).toEqual([]);
    },
  );

  it('rejects mismatched, conflicting and malformed immutable Call facts', async () => {
    const { run, declared } = await declaredCall();
    const fact = childOutcome(declared);
    await expect(
      run.advance(declared.checkpoint, {
        callOutcomes: [fact, { ...fact, callId: randomUUID() }],
      }),
    ).rejects.toThrow(/conflict/u);
    await expect(
      run.advance(declared.checkpoint, {
        callOutcomes: [{ ...fact, nodeId: 'manual' }],
      }),
    ).rejects.toThrow(/scope/u);
    await expect(
      run.advance(declared.checkpoint, {
        callOutcomes: [{ ...fact, callId: 'invalid' }],
      }),
    ).rejects.toThrow();
    await expect(
      run.advance(declared.checkpoint, {
        callOutcomes: [{ ...fact, reasonCode: 'private credential text' }],
      }),
    ).rejects.toThrow();
    const completed = await run.advance(declared.checkpoint, {
      callOutcomes: [fact, fact],
    });
    expect(
      completed.events.filter(({ name }) => name === 'node.succeeded'),
    ).toHaveLength(1);
    await expect(
      run.advance(completed.checkpoint, {
        callOutcomes: [{ ...fact, callId: randomUUID() }],
      }),
    ).rejects.toThrow(/identity/u);
  });
});
