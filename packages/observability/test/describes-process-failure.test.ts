import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { describeProcessFailure } from '../src/startup.js';

describe('describing why a process could not run', () => {
  it('names each invalid setting without its value', () => {
    const parsed = z
      .object({ DATABASE_URL: z.url(), REDIS_URL: z.string() })
      .safeParse({ DATABASE_URL: 'not a url: do-not-print-me' });

    const described = describeProcessFailure(
      new Error('Invalid worker configuration', { cause: parsed.error }),
    );

    expect(described).toContain('Invalid worker configuration');
    expect(described).toContain('DATABASE_URL');
    expect(described).toContain('REDIS_URL');
    expect(described).not.toContain('do-not-print-me');
  });

  it('keeps the whole chain of causes', () => {
    expect(
      describeProcessFailure(
        new Error('Could not start', { cause: new Error('Redis refused') }),
      ),
    ).toBe('Could not start: Redis refused');
  });

  it('reads through an aggregate', () => {
    expect(
      describeProcessFailure(
        new AggregateError([new Error('first'), new Error('second')], 'many'),
      ),
    ).toBe('first: second');
  });

  it('cuts a password out of a connection string in a message', () => {
    const described = describeProcessFailure(
      new Error(
        'connect to postgresql://user:do-not-print-me@db:5432/x failed',
      ),
    );
    expect(described).not.toContain('do-not-print-me');
  });

  it('has an answer for a thrown non-error', () => {
    expect(describeProcessFailure('nope')).toBe('no reason given');
  });
});
