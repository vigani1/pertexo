import {
  parseOperatorDatabaseConfig,
  type DatabaseConfig,
} from '@pertexo/database/platform';
import {
  parseObservabilityConfig,
  type ObservabilityConfig,
} from '@pertexo/observability/config';
import { z } from 'zod';

const dryRunSchema = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const baseEnvironmentSchema = z.object({
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  NODE_ENV: z
    .enum(['development', 'test', 'staging', 'production'])
    .default('development'),
  OPERATOR_ACTOR_REF: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u),
  OPERATOR_COMMAND_ID: z.uuid(),
  OPERATOR_REASON: z.string().min(1).max(512),
  OPERATOR_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .default(30_000),
  OPERATOR_WORKSPACE_ID: z.uuid(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  SERVICE_VERSION: z.string().trim().min(1).default('0.0.0-dev'),
});

const environmentSchema = z
  .discriminatedUnion('OPERATOR_COMMAND_TYPE', [
    baseEnvironmentSchema.extend({
      OPERATOR_COMMAND_TYPE: z.literal('outbox.redispatch'),
      OPERATOR_DRY_RUN: dryRunSchema,
      OPERATOR_OUTBOX_EVENT_ID: z.uuid(),
    }),
    baseEnvironmentSchema.extend({
      OPERATOR_COMMAND_TYPE: z.literal('operator.status'),
    }),
    baseEnvironmentSchema.extend({
      OPERATOR_ATTEMPT_ACTION: z.enum(['reclaim', 'outcome_unknown']),
      OPERATOR_ATTEMPT_ID: z.uuid(),
      OPERATOR_COMMAND_TYPE: z.literal('attempt.reconcile'),
      OPERATOR_DRY_RUN: dryRunSchema,
      OPERATOR_EXPECTED_FENCE_TOKEN: z.coerce.number().int().positive(),
    }),
    baseEnvironmentSchema.extend({
      OPERATOR_COMMAND_TYPE: z.literal('due-work.resume'),
      OPERATOR_DRY_RUN: dryRunSchema,
      OPERATOR_RUN_ID: z.uuid(),
    }),
    baseEnvironmentSchema.extend({
      OPERATOR_ATTEMPT_ID: z.uuid(),
      OPERATOR_COMMAND_TYPE: z.literal('unknown-outcome.record-evidence'),
      OPERATOR_EVIDENCE_KIND: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/u),
      OPERATOR_EVIDENCE_REF: z.string().transform((value, context) => {
        try {
          const parsed: unknown = JSON.parse(value);
          return z.record(z.string(), z.unknown()).parse(parsed);
        } catch {
          context.addIssue({
            code: 'custom',
            message: 'Invalid evidence JSON',
          });
          return z.NEVER;
        }
      }),
    }),
    baseEnvironmentSchema.extend({
      OPERATOR_COMMAND_TYPE: z.literal('run.cancel'),
      OPERATOR_DRY_RUN: dryRunSchema,
      OPERATOR_RUN_ID: z.uuid(),
    }),
    baseEnvironmentSchema.extend({
      OPERATOR_COMMAND_TYPE: z.literal('run.replay'),
      OPERATOR_DRY_RUN: dryRunSchema,
      OPERATOR_RUN_INPUT: z.string().transform((value, context) => {
        try {
          const parsed = z.json().parse(JSON.parse(value));
          if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > 65_536)
            throw new Error('Input is too large');
          return parsed;
        } catch {
          context.addIssue({
            code: 'custom',
            message: 'Invalid run input JSON',
          });
          return z.NEVER;
        }
      }),
      OPERATOR_RUN_ID: z.uuid(),
      OPERATOR_WORKFLOW_VERSION_ID: z.uuid(),
    }),
    baseEnvironmentSchema.extend({
      OPERATOR_COMMAND_TYPE: z.literal('trigger.reconcile'),
      OPERATOR_DRY_RUN: dryRunSchema,
      OPERATOR_WORKFLOW_ID: z.uuid(),
    }),
  ])
  .superRefine((value, context) => {
    if (
      value.NODE_ENV === 'production' &&
      value.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
    )
      context.addIssue({
        code: 'custom',
        message: 'Production operator job requires OTLP telemetry export',
        path: ['OTEL_EXPORTER_OTLP_ENDPOINT'],
      });
  });

export interface OperatorCommandConfig {
  readonly command:
    | Readonly<{
        actorRef: string;
        commandId: string;
        dryRun: boolean;
        outboxEventId: string;
        reason: string;
        type: 'outbox.redispatch';
        workspaceId: string;
      }>
    | Readonly<{
        actorRef: string;
        commandId: string;
        dryRun: boolean;
        reason: string;
        runInput: z.infer<ReturnType<typeof z.json>>;
        sourceRunId: string;
        type: 'run.replay';
        workflowVersionId: string;
        workspaceId: string;
      }>
    | Readonly<{
        actorRef: string;
        commandId: string;
        reason: string;
        type: 'operator.status';
        workspaceId: string;
      }>
    | Readonly<{
        action: 'outcome_unknown' | 'reclaim';
        actorRef: string;
        attemptId: string;
        commandId: string;
        dryRun: boolean;
        expectedFenceToken: number;
        reason: string;
        type: 'attempt.reconcile';
        workspaceId: string;
      }>
    | Readonly<{
        actorRef: string;
        commandId: string;
        dryRun: boolean;
        reason: string;
        runId: string;
        type: 'due-work.resume' | 'run.cancel';
        workspaceId: string;
      }>
    | Readonly<{
        actorRef: string;
        attemptId: string;
        commandId: string;
        evidenceKind: string;
        evidenceRef: Readonly<Record<string, unknown>>;
        reason: string;
        type: 'unknown-outcome.record-evidence';
        workspaceId: string;
      }>
    | Readonly<{
        actorRef: string;
        commandId: string;
        dryRun: boolean;
        reason: string;
        type: 'trigger.reconcile';
        workflowId: string;
        workspaceId: string;
      }>;
  readonly database: DatabaseConfig;
  readonly observability: ObservabilityConfig;
  readonly timeoutMs: number;
}

type ParsedOperatorEnvironment = z.infer<typeof environmentSchema>;

function toOperatorCommand(
  parsed: ParsedOperatorEnvironment,
): OperatorCommandConfig['command'] {
  const auditIdentity = {
    actorRef: parsed.OPERATOR_ACTOR_REF,
    commandId: parsed.OPERATOR_COMMAND_ID,
    reason: parsed.OPERATOR_REASON,
    workspaceId: parsed.OPERATOR_WORKSPACE_ID,
  };
  switch (parsed.OPERATOR_COMMAND_TYPE) {
    case 'operator.status':
      return Object.freeze({
        ...auditIdentity,
        type: parsed.OPERATOR_COMMAND_TYPE,
      });
    case 'outbox.redispatch':
      return Object.freeze({
        ...auditIdentity,
        dryRun: parsed.OPERATOR_DRY_RUN,
        outboxEventId: parsed.OPERATOR_OUTBOX_EVENT_ID,
        type: parsed.OPERATOR_COMMAND_TYPE,
      });
    case 'attempt.reconcile':
      return Object.freeze({
        ...auditIdentity,
        action: parsed.OPERATOR_ATTEMPT_ACTION,
        attemptId: parsed.OPERATOR_ATTEMPT_ID,
        dryRun: parsed.OPERATOR_DRY_RUN,
        expectedFenceToken: parsed.OPERATOR_EXPECTED_FENCE_TOKEN,
        type: parsed.OPERATOR_COMMAND_TYPE,
      });
    case 'due-work.resume':
    case 'run.cancel':
      return Object.freeze({
        ...auditIdentity,
        dryRun: parsed.OPERATOR_DRY_RUN,
        runId: parsed.OPERATOR_RUN_ID,
        type: parsed.OPERATOR_COMMAND_TYPE,
      });
    case 'unknown-outcome.record-evidence':
      return Object.freeze({
        ...auditIdentity,
        attemptId: parsed.OPERATOR_ATTEMPT_ID,
        evidenceKind: parsed.OPERATOR_EVIDENCE_KIND,
        evidenceRef: Object.freeze(parsed.OPERATOR_EVIDENCE_REF),
        type: parsed.OPERATOR_COMMAND_TYPE,
      });
    case 'trigger.reconcile':
      return Object.freeze({
        ...auditIdentity,
        dryRun: parsed.OPERATOR_DRY_RUN,
        type: parsed.OPERATOR_COMMAND_TYPE,
        workflowId: parsed.OPERATOR_WORKFLOW_ID,
      });
    case 'run.replay':
      return Object.freeze({
        ...auditIdentity,
        dryRun: parsed.OPERATOR_DRY_RUN,
        runInput: parsed.OPERATOR_RUN_INPUT,
        sourceRunId: parsed.OPERATOR_RUN_ID,
        type: parsed.OPERATOR_COMMAND_TYPE,
        workflowVersionId: parsed.OPERATOR_WORKFLOW_VERSION_ID,
      });
  }
}

export function parseOperatorCommandConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): OperatorCommandConfig {
  const parsed = environmentSchema.parse(environment);
  const database = parseOperatorDatabaseConfig(environment);
  return Object.freeze({
    command: toOperatorCommand(parsed),
    database,
    observability: parseObservabilityConfig({
      environment: parsed.NODE_ENV,
      logLevel: parsed.LOG_LEVEL,
      ...(parsed.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
        ? {}
        : { otlpHttpEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT }),
      serviceName: 'pertexo-ops',
      serviceVersion: parsed.SERVICE_VERSION,
    }),
    timeoutMs: parsed.OPERATOR_TIMEOUT_MS,
  });
}
