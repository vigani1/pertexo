import { describe, expect, it } from 'vitest';
import {
  parseCheckpoint,
  WORKFLOW_CHECKPOINT_LIMITS,
} from '../../../src/index.js';
import { checkpoint } from '../../support/advance-workflow.js';

describe('checkpoint seam', () => {
  it('never invokes inherited toJSON while measuring checkpoint bytes', () => {
    let getterCalls = 0;
    const original = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'toJSON',
    );
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      get() {
        getterCalls += 1;
        return () => checkpoint();
      },
    });
    try {
      expect(parseCheckpoint(checkpoint()).workflowVersionId).toBe(
        checkpoint().workflowVersionId,
      );
      expect(() =>
        parseCheckpoint({ ...checkpoint(), readySet: () => 'bad' }),
      ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
      expect(getterCalls).toBe(0);
    } finally {
      if (original === undefined)
        Reflect.deleteProperty(Object.prototype, 'toJSON');
      else Object.defineProperty(Object.prototype, 'toJSON', original);
    }
  });
  it('rejects hidden fields and accessors without invoking them', () => {
    let getterCalls = 0;
    const hiddenRequired = { ...checkpoint() } as Record<string, unknown>;
    Object.defineProperty(hiddenRequired, 'workflowVersionId', {
      enumerable: false,
      get: () => {
        getterCalls += 1;
        return checkpoint().workflowVersionId;
      },
    });
    expect(() => parseCheckpoint(hiddenRequired)).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );
    expect(getterCalls).toBe(0);

    const hiddenUnknown = { ...checkpoint() } as Record<string, unknown>;
    Object.defineProperty(hiddenUnknown, 'hidden', {
      enumerable: false,
      value: true,
    });
    expect(() => parseCheckpoint(hiddenUnknown)).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );
  });
  it('rejects top-level and nested proxies without running their traps', () => {
    let trapCalls = 0;
    const hostile = new Proxy(checkpoint(), {
      getPrototypeOf: () => {
        trapCalls += 1;
        throw new Error('proxy trap ran');
      },
      ownKeys: () => {
        trapCalls += 1;
        throw new Error('proxy trap ran');
      },
    });
    expect(() => parseCheckpoint(hostile)).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );
    const nested = {
      ...checkpoint(),
      invocations: [
        new Proxy(
          {
            invocationKey: 'a',
            nodeId: 'a',
            status: 'ready',
            attemptNumber: 0,
          },
          {
            getOwnPropertyDescriptor: () => {
              trapCalls += 1;
              throw new Error('nested proxy trap ran');
            },
          },
        ),
      ],
      readySet: ['a'],
    };
    expect(() => parseCheckpoint(nested)).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );
    expect(trapCalls).toBe(0);
  });
  it('rejects a wide object at the incremental member cap', () => {
    const wide: Record<string, number> = {};
    for (let index = 0; index <= WORKFLOW_CHECKPOINT_LIMITS.members; index += 1)
      wide[`field-${String(index)}`] = index;
    const startedAt = performance.now();
    expect(() => parseCheckpoint({ ...checkpoint(), readySet: wide })).toThrow(
      expect.objectContaining({ code: 'checkpoint_invalid' }),
    );
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});
