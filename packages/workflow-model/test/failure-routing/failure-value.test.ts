import { describe, expect, it } from 'vitest';
import {
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
    { ...value, message: 'provider secret' },
    { ...value, errorKind: 'internal', safeErrorCode: 'execution.internal' },
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
