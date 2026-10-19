import { describe, expect, it } from 'vitest';
import {
  describeStepError,
  shortStepError,
} from '@/features/workflow-runs/model/step-inspection/step-error-copy';

const fallback = describeStepError('nothing.known');

describe('step error copy', () => {
  it('says in words what each kind of step failure means', () => {
    for (const code of [
      'execution.provider',
      'execution.authentication',
      'execution.rate_limit',
      'execution.network',
      'execution.timeout',
      'execution.configuration',
      'execution.internal',
      'execution.output_invalid',
      'code.runtime_error',
      'code.syntax_error',
      'code.timeout',
      'code.memory_limit',
      'code.output_invalid',
      'code.module_refused',
    ])
      expect(describeStepError(code), code).not.toEqual(fallback);
    expect(describeStepError('execution.provider').advice).toMatch(
      /Return error responses/u,
    );
  });

  it('gives a step test the same few words as a run', () => {
    expect(shortStepError('execution.timeout')).toBe(
      'the service didn’t answer in time',
    );
    expect(shortStepError('preview.timeout')).toBe(
      'the service didn’t answer in time',
    );
    expect(shortStepError('preview.something_new')).toBe(
      'stopped with an error',
    );
  });
});
