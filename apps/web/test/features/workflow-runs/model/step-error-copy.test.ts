import { describe, expect, it } from 'vitest';
import {
  describeStepError,
  shortStepError,
} from '@/features/workflow-runs/model/step-inspection/error-copy';

const fallback = describeStepError('nothing.known');

describe('step error copy', () => {
  // M3: every OAuth2 step failure says what happened, not "the code tells support".
  it.fails.each([
    'http.oauth2_not_connected',
    'http.oauth2_grant_revoked',
    'http.oauth2_client_rejected',
    'http.oauth2_token_expired',
    'http.oauth2_token_rate_limited',
    'http.oauth2_token_endpoint_unavailable',
    'http.oauth2_token_response_invalid',
    'http.oauth2_token_address_blocked',
    'http.oauth2_refresh_busy',
    'http.oauth2_host_not_allowed',
  ])('M3 says in words what %s means, here and in the history', (code) => {
    expect(describeStepError(code)).not.toEqual(fallback);
    expect(shortStepError(code)).not.toEqual(shortStepError('nothing.known'));
  });

  // M3: these four are fixed by signing in again, so the step offers Reconnect.
  it.fails.each([
    'http.oauth2_not_connected',
    'http.oauth2_grant_revoked',
    'http.oauth2_client_rejected',
    'http.oauth2_token_expired',
  ])('M3 %s offers Reconnect', (code) => {
    expect(describeStepError(code).fix).toBe('reconnect');
  });

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
      'email.too_many_attachments',
      'email.attachments_too_large',
    ])
      expect(describeStepError(code), code).not.toEqual(fallback);
    expect(describeStepError('email.attachments_too_large').advice).toMatch(
      /6 MB/u,
    );
    expect(shortStepError('email.too_many_attachments')).toBe(
      'too many attachments',
    );
    expect(describeStepError('execution.provider').advice).toMatch(
      /Return error responses/u,
    );
  });

  it('says what expired for an approval, a form and a callback, and stays general otherwise', () => {
    expect(
      describeStepError('pending_task.expired', 'core.approval').sentence,
    ).toBe('Nobody approved or rejected this before it expired.');
    expect(
      describeStepError('pending_task.expired', 'core.request_input').sentence,
    ).toBe('Nobody filled in this form before it expired.');
    expect(
      describeStepError('pending_task.expired', 'core.wait').sentence,
    ).toBe('The other service didn’t call back in time.');
    const general = describeStepError('pending_task.expired');
    expect(general.sentence).toBe(
      'This task expired before anyone answered it.',
    );
    expect(general.advice).not.toMatch(/callback/u);
    // Other codes ignore the step type.
    expect(describeStepError('execution.timeout', 'core.approval')).toEqual(
      describeStepError('execution.timeout'),
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
