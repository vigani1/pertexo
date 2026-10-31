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

  it.each([
    ['redis', 'redis://:do-not-print-me@redis:6379/0 refused'],
    ['a second scheme', 'smtp://mail:do-not-print-me@mail:587 refused'],
    ['a cause', 'Could not start'],
  ])('keeps a password out of %s', (_where, message) => {
    const described = describeProcessFailure(
      new Error(message, {
        cause: new Error('postgresql://user:do-not-print-me@db/x refused'),
      }),
    );
    expect(described).not.toContain('do-not-print-me');
  });

  // The rule's real case: a schema's own message may quote what it refused.
  it('never prints a message a schema wrote about a setting', () => {
    const parsed = z
      .object({
        API_KEY: z.string().refine(() => false, {
          error: (issue) => `${String(issue.input)} is not a key`,
        }),
      })
      .safeParse({ API_KEY: 'do-not-print-me' });

    const described = describeProcessFailure(
      new Error('Invalid worker configuration', { cause: parsed.error }),
    );

    expect(described).toContain('API_KEY');
    expect(described).not.toContain('do-not-print-me');
  });

  it('keeps a setting value out, however deep the settings failure is', () => {
    const parsed = z
      .object({ DATABASE_URL: z.url() })
      .safeParse({ DATABASE_URL: 'do-not-print-me' });

    const described = describeProcessFailure(
      new AggregateError([
        new Error('Could not start', { cause: parsed.error }),
      ]),
    );

    expect(described).toContain('DATABASE_URL');
    expect(described).not.toContain('do-not-print-me');
  });

  it('survives a cause that points back at itself', () => {
    const looped = new Error('looped');
    looped.cause = looped;

    expect(describeProcessFailure(looped)).toContain('looped');
  });

  it('stays short enough for one log line', () => {
    expect(
      describeProcessFailure(new Error('x'.repeat(10_000))).length,
    ).toBeLessThanOrEqual(2_000);
  });

  it('has an answer for a thrown non-error', () => {
    expect(describeProcessFailure('nope')).toBe('no reason given');
  });
});
