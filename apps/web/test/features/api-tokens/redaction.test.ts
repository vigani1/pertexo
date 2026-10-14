import { describe, expect, it } from 'vitest';
import {
  ownedAutomationFailure,
  withOwnedCredential,
} from '../../../e2e-live/support/automation/credential-action';

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
  it('preserves an allowlisted phase and public code while stripping raw failure data', async () => {
    const failure = Object.assign(
      ownedAutomationFailure('workflows.publish', {
        code: 'workflow.revision_conflict',
        credential: 'synthetic-private-material',
      }),
      {
        cause: new Error('Bearer synthetic-private-material'),
        errorContext: 'synthetic-private-material',
      },
    );
    const result = await withOwnedCredential(() =>
      Promise.reject(failure),
    ).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({
      message:
        'Owned automation action failed during publication (workflow.revision_conflict); sensitive details omitted.',
    });
    expect(result).not.toHaveProperty('cause');
    expect(result).not.toHaveProperty('errorContext');
    expect(JSON.stringify(result)).not.toContain('synthetic-private-material');
  });
  it('does not reflect arbitrary phases, codes or accessors', () => {
    const result = ownedAutomationFailure('Bearer synthetic-private-material', {
      code: 'synthetic-private-material',
    });
    expect(result.message).toBe(
      'Owned automation action failed during CLI request; sensitive details omitted.',
    );
    expect(JSON.stringify(result)).not.toContain('synthetic-private-material');
    const hostile = Object.defineProperty({}, 'code', {
      get() {
        throw new Error('synthetic-private-material');
      },
    });
    expect(ownedAutomationFailure('runs.start', hostile).message).toContain(
      'run start',
    );
  });
});
