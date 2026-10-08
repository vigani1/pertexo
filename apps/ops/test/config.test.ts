import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { parseOperatorCommandConfig } from '../src/config.js';

const ids = {
  attempt: '11111111-1111-4111-8111-111111111111',
  command: '22222222-2222-4222-8222-222222222222',
  purge: '33333333-3333-4333-8333-333333333333',
  run: '44444444-4444-4444-8444-444444444444',
  workspace: '55555555-5555-4555-8555-555555555555',
  workflow: '66666666-6666-4666-8666-666666666666',
  workflowVersion: '77777777-7777-4777-8777-777777777777',
} as const;

function validOutboxEnvironment(): Record<string, string | undefined> {
  return {
    DATABASE_OPERATOR_URL:
      'postgresql://pertexo_operator:secret@localhost:5432/pertexo',
    NODE_ENV: 'test',
    OPERATOR_ACTOR_REF: 'ci-test-operator',
    OPERATOR_COMMAND_ID: ids.command,
    OPERATOR_COMMAND_TYPE: 'outbox.redispatch',
    OPERATOR_DRY_RUN: 'true',
    OPERATOR_OUTBOX_EVENT_ID: ids.purge,
    OPERATOR_REASON: 'prove safe redispatch',
    OPERATOR_WORKSPACE_ID: ids.workspace,
  };
}

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

  it.each([
    {
      label: 'due-work resume',
      environment: {
        OPERATOR_COMMAND_TYPE: 'due-work.resume',
        OPERATOR_DRY_RUN: 'true',
        OPERATOR_RUN_ID: ids.run,
      },
      expected: {
        actorRef: 'ci-test-operator',
        commandId: ids.command,
        dryRun: true,
        reason: 'prove safe redispatch',
        runId: ids.run,
        type: 'due-work.resume',
        workspaceId: ids.workspace,
      },
    },
    {
      label: 'run cancellation',
      environment: {
        OPERATOR_COMMAND_TYPE: 'run.cancel',
        OPERATOR_DRY_RUN: 'false',
        OPERATOR_RUN_ID: ids.run,
      },
      expected: {
        actorRef: 'ci-test-operator',
        commandId: ids.command,
        dryRun: false,
        reason: 'prove safe redispatch',
        runId: ids.run,
        type: 'run.cancel',
        workspaceId: ids.workspace,
      },
    },
    {
      label: 'unknown-outcome evidence',
      environment: {
        OPERATOR_ATTEMPT_ID: ids.attempt,
        OPERATOR_COMMAND_TYPE: 'unknown-outcome.record-evidence',
        OPERATOR_DRY_RUN: undefined,
        OPERATOR_EVIDENCE_KIND: 'provider.receipt',
        OPERATOR_EVIDENCE_REF: '{"receipt":"safe-ref"}',
      },
      expected: {
        actorRef: 'ci-test-operator',
        attemptId: ids.attempt,
        commandId: ids.command,
        evidenceKind: 'provider.receipt',
        evidenceRef: { receipt: 'safe-ref' },
        reason: 'prove safe redispatch',
        type: 'unknown-outcome.record-evidence',
        workspaceId: ids.workspace,
      },
    },
    {
      label: 'purge rerun',
      environment: {
        OPERATOR_COMMAND_TYPE: 'purge.rerun',
        OPERATOR_DRY_RUN: 'false',
        OPERATOR_PURGE_JOB_ID: ids.purge,
      },
      expected: {
        actorRef: 'ci-test-operator',
        commandId: ids.command,
        dryRun: false,
        reason: 'prove safe redispatch',
        targetId: ids.purge,
        targetType: 'workspace_purge_job',
        type: 'purge.rerun',
        workspaceId: ids.workspace,
      },
    },
  ])(
    'maps $label with the shared audit identity intact',
    ({ environment, expected }) => {
      const command = parseOperatorCommandConfig({
        ...validOutboxEnvironment(),
        ...environment,
      }).command;

      expect(command).toEqual(expected);
      expect(Object.isFrozen(command)).toBe(true);
    },
  );

  it.each([
    {
      label: 'missing explicit dry-run',
      change: { OPERATOR_DRY_RUN: undefined },
      expected: /OPERATOR_DRY_RUN/u,
    },
    {
      label: 'invalid explicit dry-run',
      change: { OPERATOR_DRY_RUN: 'yes' },
      expected: /OPERATOR_DRY_RUN/u,
    },
    {
      label: 'timeout below the minimum',
      change: { OPERATOR_TIMEOUT_MS: '999' },
      expected: /OPERATOR_TIMEOUT_MS/u,
    },
    {
      label: 'timeout above the maximum',
      change: { OPERATOR_TIMEOUT_MS: '300001' },
      expected: /OPERATOR_TIMEOUT_MS/u,
    },
    {
      label: 'invalid actor reference',
      change: { OPERATOR_ACTOR_REF: ' invalid actor' },
      expected: /OPERATOR_ACTOR_REF/u,
    },
    {
      label: 'empty reason',
      change: { OPERATOR_REASON: '' },
      expected: /OPERATOR_REASON/u,
    },
    {
      label: 'overlong reason',
      change: { OPERATOR_REASON: 'r'.repeat(513) },
      expected: /OPERATOR_REASON/u,
    },
    {
      label: 'invalid command UUID',
      change: { OPERATOR_COMMAND_ID: 'not-a-uuid' },
      expected: /OPERATOR_COMMAND_ID/u,
    },
    {
      label: 'invalid workspace UUID',
      change: { OPERATOR_WORKSPACE_ID: 'not-a-uuid' },
      expected: /OPERATOR_WORKSPACE_ID/u,
    },
    {
      label: 'invalid command-specific UUID',
      change: { OPERATOR_OUTBOX_EVENT_ID: 'not-a-uuid' },
      expected: /OPERATOR_OUTBOX_EVENT_ID/u,
    },
    {
      label: 'production without telemetry export',
      change: { NODE_ENV: 'production' },
      expected: /Production operator job requires OTLP telemetry export/u,
    },
  ])(
    'rejects $label from an otherwise valid environment',
    ({ change, expected }) => {
      expect(() =>
        parseOperatorCommandConfig({
          ...validOutboxEnvironment(),
          ...change,
        }),
      ).toThrow(expected);
    },
  );

  it.each([
    ['array evidence', '[]'],
    ['scalar evidence', '42'],
    ['malformed evidence', '{'],
  ])('rejects %s with the evidence-specific guard', (_label, evidence) => {
    expect(() =>
      parseOperatorCommandConfig({
        ...validOutboxEnvironment(),
        OPERATOR_ATTEMPT_ID: ids.attempt,
        OPERATOR_COMMAND_TYPE: 'unknown-outcome.record-evidence',
        OPERATOR_DRY_RUN: undefined,
        OPERATOR_EVIDENCE_KIND: 'provider.receipt',
        OPERATOR_EVIDENCE_REF: evidence,
      }),
    ).toThrow(/Invalid evidence JSON/u);
  });

  it.each([
    ['malformed', '{'],
    ['over-limit', JSON.stringify({ input: 'x'.repeat(65_536) })],
  ])(
    'rejects %s replay input with the replay-specific guard',
    (_label, runInput) => {
      expect(() =>
        parseOperatorCommandConfig({
          ...validOutboxEnvironment(),
          OPERATOR_COMMAND_TYPE: 'run.replay',
          OPERATOR_DRY_RUN: 'false',
          OPERATOR_RUN_ID: ids.run,
          OPERATOR_RUN_INPUT: runInput,
          OPERATOR_WORKFLOW_VERSION_ID: ids.workflowVersion,
        }),
      ).toThrow(/Invalid run input JSON/u);
    },
  );

  it('accepts production only with an explicit telemetry endpoint', () => {
    expect(
      parseOperatorCommandConfig({
        ...validOutboxEnvironment(),
        NODE_ENV: 'production',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.test',
      }).observability.otlpHttpEndpoint,
    ).toBe('https://otel.example.test');
  });
});
