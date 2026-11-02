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
