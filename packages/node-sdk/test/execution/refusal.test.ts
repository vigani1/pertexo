import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  describeNodeRefusal,
  NodeConfigValidationError,
  NodeExecutorFailure,
  NodeInputValidationError,
} from '../../src/server.js';

const issues = (value: unknown) =>
  z
    .object({ items: z.array(z.object({ id: z.number() })), name: z.string() })
    .safeParse(value).error;

describe('a step refusal in words', () => {
  it('keeps the sentence the step wrote', () => {
    expect(
      describeNodeRefusal(
        new NodeInputValidationError('Use a date like 2026-10-19.'),
      ),
    ).toBe('Use a date like 2026-10-19.');
  });

  it('names the first schema issue, where it sits and how many follow', () => {
    expect(
      describeNodeRefusal(
        new NodeInputValidationError(issues({ items: [{ id: 'x' }], name: 3 })),
      ),
    ).toBe(
      'Input items[0].id: Invalid input: expected number, received string (and 1 more)',
    );
    expect(
      describeNodeRefusal(new NodeConfigValidationError(issues({ items: [] }))),
    ).toBe('Setting name: Invalid input: expected string, received undefined');
  });

  it('bounds a long reason', () => {
    const reason = describeNodeRefusal(
      new NodeInputValidationError('x'.repeat(2_000)),
    );
    expect(reason).toHaveLength(512);
    expect(reason?.endsWith('…')).toBe(true);
  });

  it('has nothing to say for other failures', () => {
    expect(describeNodeRefusal(new Error('secret detail'))).toBeUndefined();
    expect(
      describeNodeRefusal(new NodeInputValidationError(new Error('secret'))),
    ).toBeUndefined();
    expect(
      describeNodeRefusal(
        new NodeExecutorFailure({
          kind: 'failed',
          errorKind: 'provider',
          possiblyDispatched: false,
        }),
      ),
    ).toBeUndefined();
    expect(describeNodeRefusal(new NodeInputValidationError('  '))).toBe(
      undefined,
    );
  });
});
