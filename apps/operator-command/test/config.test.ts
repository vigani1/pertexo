import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { parseOperatorCommandConfig } from '../src/config.js';

describe('operator command config', () => {
  it('requires bounded explicit command identity, actor, reason, and dry-run', () => {
    const commandId = randomUUID();
    const outboxEventId = randomUUID();
    const workspaceId = randomUUID();
    const config = parseOperatorCommandConfig({
      DATABASE_OPERATOR_URL:
        'postgresql://pertexo_operator:secret@localhost:5432/pertexo',
      NODE_ENV: 'test',
      OPERATOR_ACTOR_REF: 'ci-test-operator',
      OPERATOR_COMMAND_ID: commandId,
      OPERATOR_COMMAND_TYPE: 'outbox.redispatch',
      OPERATOR_DRY_RUN: 'true',
      OPERATOR_OUTBOX_EVENT_ID: outboxEventId,
      OPERATOR_REASON: 'prove safe redispatch',
      OPERATOR_WORKSPACE_ID: workspaceId,
    });

    expect(config.command).toEqual({
      actorRef: 'ci-test-operator',
      commandId,
      dryRun: true,
      outboxEventId,
      reason: 'prove safe redispatch',
      type: 'outbox.redispatch',
      workspaceId,
    });
    expect(config.database.max).toBe(1);
    expect(config.operatorRole).toBe('pertexo_operator');
  });

  it('rejects an implicit or unbounded operator invocation', () => {
    expect(() =>
      parseOperatorCommandConfig({
        DATABASE_OPERATOR_URL:
          'postgresql://pertexo_operator:secret@localhost:5432/pertexo',
      }),
    ).toThrow();
  });

  it('parses status lookup without mutation material', () => {
    const commandId = randomUUID();
    expect(
      parseOperatorCommandConfig({
        DATABASE_OPERATOR_URL:
          'postgresql://pertexo_operator:secret@localhost:5432/pertexo',
        OPERATOR_ACTOR_REF: 'ci-test-operator',
        OPERATOR_COMMAND_ID: commandId,
        OPERATOR_COMMAND_TYPE: 'operator.status',
        OPERATOR_REASON: 'inspect durable result',
        OPERATOR_WORKSPACE_ID: '9b7f2d18-938c-47bd-aab8-b9722f7600c4',
      }).command,
    ).toEqual({
      actorRef: 'ci-test-operator',
      commandId,
      reason: 'inspect durable result',
      type: 'operator.status',
      workspaceId: '9b7f2d18-938c-47bd-aab8-b9722f7600c4',
    });
  });

  it('parses bounded execution recovery material', () => {
    const attemptId = randomUUID();
    const commandId = randomUUID();
    const workspaceId = randomUUID();
    expect(
      parseOperatorCommandConfig({
        DATABASE_OPERATOR_URL:
          'postgresql://pertexo_operator:secret@localhost:5432/pertexo',
        OPERATOR_ACTOR_REF: 'ci-test-operator',
        OPERATOR_ATTEMPT_ACTION: 'reclaim',
        OPERATOR_ATTEMPT_ID: attemptId,
        OPERATOR_COMMAND_ID: commandId,
        OPERATOR_COMMAND_TYPE: 'attempt.reconcile',
        OPERATOR_DRY_RUN: 'true',
        OPERATOR_EXPECTED_FENCE_TOKEN: '7',
        OPERATOR_REASON: 'inspect expired lease',
        OPERATOR_WORKSPACE_ID: workspaceId,
      }).command,
    ).toEqual({
      action: 'reclaim',
      actorRef: 'ci-test-operator',
      attemptId,
      commandId,
      dryRun: true,
      expectedFenceToken: 7,
      reason: 'inspect expired lease',
      type: 'attempt.reconcile',
      workspaceId,
    });
  });
});
