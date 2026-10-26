import { describe, expect, it } from 'vitest';
import {
  approvalConfigSchema,
  continuesOnExpiry,
  taskExpiryChoice,
  inputRequestConfigSchema,
  pendingTaskOutputPorts,
  timedOutTaskOutput,
  timedOutTaskOutputSchema,
} from '../../src/index.js';

const approval = { key: 'core.approval', version: 1 } as const;
const inputRequest = { key: 'core.request_input', version: 1 } as const;

describe('When nobody responds', () => {
  it('fails the step unless the setup chooses the Timed out path', () => {
    // A setup saved before the choice existed parses to itself and fails.
    const legacy = approvalConfigSchema.parse({});
    expect(legacy).not.toHaveProperty('onExpiry');
    expect(taskExpiryChoice(legacy)).toBe('fail');
    expect(taskExpiryChoice(inputRequestConfigSchema.parse({}))).toBe('fail');
    expect(approvalConfigSchema.parse({ onExpiry: 'continue' }).onExpiry).toBe(
      'continue',
    );
    for (const onExpiry of ['approve', true, null])
      expect(approvalConfigSchema.safeParse({ onExpiry }).success).toBe(false);
  });

  it('continues only for an Approval or Request input that chose it', () => {
    expect(continuesOnExpiry({ definition: approval, config: {} })).toBe(false);
    expect(
      continuesOnExpiry({ definition: approval, config: { onExpiry: 'fail' } }),
    ).toBe(false);
    expect(
      continuesOnExpiry({
        definition: inputRequest,
        config: { onExpiry: 'continue' },
      }),
    ).toBe(true);
    expect(
      continuesOnExpiry({
        definition: { key: 'core.wait', version: 1 },
        config: { onExpiry: 'continue' },
      }),
    ).toBe(false);
    expect(
      continuesOnExpiry({
        definition: approval,
        config: { onExpiry: 'sometimes' },
      }),
    ).toBe(false);
  });
});

describe('task output ports', () => {
  it('adds Timed out only when the step continues on it', () => {
    expect(
      pendingTaskOutputPorts({ definition: approval, config: {} }),
    ).toEqual(['approved', 'rejected']);
    expect(
      pendingTaskOutputPorts({
        definition: approval,
        config: { onExpiry: 'continue' },
      }),
    ).toEqual(['approved', 'rejected', 'timed_out']);
    expect(
      pendingTaskOutputPorts({ definition: inputRequest, config: {} }),
    ).toEqual(['out']);
    expect(
      pendingTaskOutputPorts({
        definition: inputRequest,
        config: { onExpiry: 'continue' },
      }),
    ).toEqual(['out', 'timed_out']);
  });

  it('says nothing about other steps', () => {
    expect(
      pendingTaskOutputPorts({
        definition: { key: 'core.switch', version: 1 },
      }),
    ).toBeUndefined();
  });
});

describe('timed-out output', () => {
  it('records when the task opened and expired, whom it asked and its context', () => {
    const output = timedOutTaskOutput({
      openedAt: new Date('2026-10-20T09:00:00.000Z'),
      expiredAt: new Date('2026-10-27T09:00:00.000Z'),
      audience: { roles: ['owner'], memberIds: [] },
      context: { details: { Customer: 'Ada', Amount: 120 } },
    });
    expect(output).toEqual({
      timedOut: true,
      openedAt: '2026-10-20T09:00:00.000Z',
      expiredAt: '2026-10-27T09:00:00.000Z',
      audience: { roles: ['owner'], memberIds: [] },
      details: { Customer: 'Ada', Amount: 120 },
    });
    expect(timedOutTaskOutputSchema.safeParse(output).success).toBe(true);
  });

  it('is never mistaken for a decision', () => {
    expect(
      timedOutTaskOutputSchema.safeParse({
        decision: 'approved',
        timedOut: true,
        openedAt: '2026-10-20T09:00:00.000Z',
        expiredAt: '2026-10-27T09:00:00.000Z',
        audience: { roles: ['owner'], memberIds: [] },
      }).success,
    ).toBe(false);
  });
});
