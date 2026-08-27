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

  it('parses a trigger reconciliation retry', () => {
    const commandId = randomUUID();
    const workflowId = randomUUID();
    const workspaceId = randomUUID();
    expect(
      parseOperatorCommandConfig({
        DATABASE_OPERATOR_URL:
          'postgresql://pertexo_operator:secret@localhost:5432/pertexo',
        OPERATOR_ACTOR_REF: 'ci-test-operator',
        OPERATOR_COMMAND_ID: commandId,
        OPERATOR_COMMAND_TYPE: 'trigger.reconcile',
        OPERATOR_DRY_RUN: 'false',
        OPERATOR_REASON: 'retry failed trigger projection',
        OPERATOR_WORKFLOW_ID: workflowId,
        OPERATOR_WORKSPACE_ID: workspaceId,
      }).command,
    ).toEqual({
      actorRef: 'ci-test-operator',
      commandId,
      dryRun: false,
      reason: 'retry failed trigger projection',
      type: 'trigger.reconcile',
      workflowId,
      workspaceId,
    });
  });

  it('parses explicit bounded replay input', () => {
    const commandId = randomUUID();
    const sourceRunId = randomUUID();
    const workflowVersionId = randomUUID();
    const workspaceId = randomUUID();
    expect(
      parseOperatorCommandConfig({
        DATABASE_OPERATOR_URL:
          'postgresql://pertexo_operator:secret@localhost:5432/pertexo',
        OPERATOR_ACTOR_REF: 'ci-test-operator',
        OPERATOR_COMMAND_ID: commandId,
        OPERATOR_COMMAND_TYPE: 'run.replay',
        OPERATOR_DRY_RUN: 'false',
        OPERATOR_REASON: 'replay reconciled run',
        OPERATOR_RUN_ID: sourceRunId,
        OPERATOR_RUN_INPUT: '{"explicit":true}',
        OPERATOR_WORKFLOW_VERSION_ID: workflowVersionId,
        OPERATOR_WORKSPACE_ID: workspaceId,
      }).command,
    ).toEqual({
      actorRef: 'ci-test-operator',
      commandId,
      dryRun: false,
      reason: 'replay reconciled run',
      runInput: { explicit: true },
      sourceRunId,
      type: 'run.replay',
      workflowVersionId,
      workspaceId,
    });
  });

  it('parses a maintenance-owned retention rerun request', () => {
    const commandId = randomUUID();
    const targetId = randomUUID();
    const workspaceId = randomUUID();
    expect(
      parseOperatorCommandConfig({
        DATABASE_OPERATOR_URL:
          'postgresql://pertexo_operator:secret@localhost:5432/pertexo',
        OPERATOR_ACTOR_REF: 'ci-test-operator',
        OPERATOR_COMMAND_ID: commandId,
        OPERATOR_COMMAND_TYPE: 'retention.rerun',
        OPERATOR_DRY_RUN: 'false',
        OPERATOR_REASON: 'wake retained batch',
        OPERATOR_RETENTION_BATCH_ID: targetId,
        OPERATOR_WORKSPACE_ID: workspaceId,
      }).command,
    ).toEqual({
      actorRef: 'ci-test-operator',
      commandId,
      dryRun: false,
      reason: 'wake retained batch',
      targetId,
      targetType: 'retention_batch',
      type: 'retention.rerun',
      workspaceId,
    });
  });
});
