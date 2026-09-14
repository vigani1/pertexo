import { describe, expect, it } from 'vitest';

import { previewPairConsistent } from '../src/execution/preview-execution-contract.js';
import { executableNodeSchema } from '../src/execution/preview-executable-node.js';

describe('preview executable-node admission', () => {
  it('snapshots a bounded null-prototype JSON object', () => {
    const config = { enabled: true };
    Object.setPrototypeOf(config, null);
    const input = { config, id: 'node-1' };
    Object.setPrototypeOf(input, null);

    expect(executableNodeSchema.parse(input)).toEqual({
      config: { enabled: true },
      id: 'node-1',
    });
  });

  it('contains hostile reflection failures without invoking accessors', () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'config', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error('must not run');
      },
    });
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('must not escape');
        },
      },
    );

    expect(executableNodeSchema.safeParse(accessor).success).toBe(false);
    expect(executableNodeSchema.safeParse(proxy).success).toBe(false);
    expect(getterCalls).toBe(0);
  });

  it('rejects non-object, over-deep and over-byte inputs before recursive parsing', () => {
    let nested: unknown = null;
    for (let depth = 0; depth < 257; depth += 1) nested = { nested };

    for (const value of [[], nested, { body: 'x'.repeat(1_048_577) }])
      expect(executableNodeSchema.safeParse(value).success).toBe(false);
  });
});

describe('preview run and attempt status pairing', () => {
  it('accepts known pairs and rejects inherited or unknown persisted values', () => {
    expect(previewPairConsistent('running', 'queued')).toBe(true);
    expect(previewPairConsistent('succeeded', 'succeeded')).toBe(true);
    expect(previewPairConsistent('toString', 'queued')).toBe(false);
    expect(previewPairConsistent('__proto__', 'running')).toBe(false);
    expect(previewPairConsistent('future_status', 'future_status')).toBe(false);
  });
});
