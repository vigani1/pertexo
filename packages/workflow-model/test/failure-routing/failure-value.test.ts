import { describe, expect, it } from 'vitest';
import {
  isRoutableExecutorFailure,
  resolveValueSource,
  workflowNodeFailureValueSchema,
} from '../../src/index.js';
const value = {
  nodeId: 'fetch',
  invocationKey: 'invocation',
  attemptNumber: 2,
  errorKind: 'authentication' as const,
  safeErrorCode: 'execution.authentication',
};
describe('safe selected failure fields', () => {
  // M2: the writer's fixed OAuth2 codes, each under the kind a step reports it as.
  it.fails.each([
    ['authentication', 'http.oauth2_not_connected'],
    ['authentication', 'http.oauth2_grant_revoked'],
    ['authentication', 'http.oauth2_client_rejected'],
    ['authentication', 'http.oauth2_token_expired'],
    ['rate_limit', 'http.oauth2_token_rate_limited'],
    ['provider', 'http.oauth2_token_endpoint_unavailable'],
    ['provider', 'http.oauth2_token_response_invalid'],
    ['provider', 'http.oauth2_refresh_busy'],
    ['configuration', 'http.oauth2_token_address_blocked'],
    ['configuration', 'http.oauth2_host_not_allowed'],
  ])('M2 accepts %s failure %s', (errorKind, safeErrorCode) => {
    expect(isRoutableExecutorFailure({ errorKind, safeErrorCode })).toBe(true);
  });

  it('M2 keeps an OAuth2 code from routing under another kind', () => {
    expect(
      isRoutableExecutorFailure({
        errorKind: 'network',
        safeErrorCode: 'http.oauth2_grant_revoked',
      }),
    ).toBe(false);
  });

  it.each(['authentication', 'network', 'provider', 'rate_limit', 'timeout'])(
    'accepts fixed %s classification',
    (kind) => {
      expect(
        workflowNodeFailureValueSchema.parse({
          ...value,
          errorKind: kind,
          safeErrorCode: `execution.${kind}`,
        }),
      ).toMatchObject({ errorKind: kind });
    },
  );
  it.each([
    ['configuration', 'execution.attempt_invalid'],
    ['configuration', 'execution.variable_missing'],
    ['configuration', 'execution.expression_failed'],
    ['configuration', 'execution.expression_limit_exceeded'],
    ['timeout', 'execution.expression_timed_out'],
    ['configuration', 'execution.table_key_conflict'],
    ['configuration', 'execution.file_input'],
    ['configuration', 'execution.loop_results_too_large'],
    ['configuration', 'code.output_invalid'],
    ['internal', 'code.runtime_error'],
    ['timeout', 'code.timeout'],
  ])('accepts the step’s own %s failure %s', (errorKind, safeErrorCode) => {
    expect(
      workflowNodeFailureValueSchema.parse({
        ...value,
        errorKind,
        safeErrorCode,
      }),
    ).toMatchObject({ errorKind, safeErrorCode });
  });
  it.each([
    { ...value, message: 'provider secret' },
    { ...value, errorKind: 'internal', safeErrorCode: 'execution.internal' },
    { ...value, errorKind: 'configuration', safeErrorCode: 'code.disabled' },
    {
      ...value,
      errorKind: 'configuration',
      safeErrorCode: 'execution.table_attempt_expired',
    },
    { ...value, errorKind: 'internal', safeErrorCode: 'code.output_invalid' },
    { ...value, safeErrorCode: 'provider.private_token' },
    { ...value, safeErrorCode: 'execution.network' },
    { ...value, attemptNumber: 0 },
  ])('rejects unapproved or inconsistent evidence', (candidate) => {
    expect(workflowNodeFailureValueSchema.safeParse(candidate).success).toBe(
      false,
    );
  });
  it('resolves failure independently of outputs and only for its exact source', async () => {
    const context = {
      runInput: null,
      nodeOutputs: { fetch: { safeErrorCode: 'not failure evidence' } },
      nodeFailure: value,
    };
    expect(
      await resolveValueSource(
        { kind: 'node_failure', nodeId: 'fetch', path: '$.safeErrorCode' },
        context,
      ),
    ).toEqual({ kind: 'value', value: 'execution.authentication' });
    expect(
      await resolveValueSource(
        { kind: 'node_failure', nodeId: 'other', path: '$' },
        context,
      ),
    ).toEqual({ kind: 'missing' });
    expect(
      await resolveValueSource(
        { kind: 'node_failure', nodeId: 'fetch', path: '$' },
        { runInput: null, nodeOutputs: context.nodeOutputs },
      ),
    ).toEqual({ kind: 'missing' });
  });
});
