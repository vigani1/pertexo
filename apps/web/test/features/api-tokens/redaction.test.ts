import { describe, expect, it } from 'vitest';
import { withOwnedCredential } from '../../../e2e-live/support/automation/credential-action';

describe('owned automation credential diagnostics', () => {
  it('preserves a successful value but strips failed bearer call logs and matcher snapshots', async () => {
    expect(await withOwnedCredential(() => Promise.resolve('result'))).toBe(
      'result',
    );
    const failure = Object.assign(
      new Error('Bearer synthetic-private-material'),
      {
        errorContext: 'textbox value: synthetic-private-material',
      },
    );
    const result = await withOwnedCredential(() =>
      Promise.reject(failure),
    ).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({
      message:
        'Owned automation credential action failed; sensitive details omitted.',
    });
    expect(result).not.toHaveProperty('errorContext');
    expect(result).not.toHaveProperty('cause');
  });
});
