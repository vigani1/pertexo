import {
  parseOperatorDatabaseConfig,
  type DatabaseConfig,
} from '@pertexo/database';
import {
  parseObservabilityConfig,
  type ObservabilityConfig,
} from '@pertexo/observability/config';
import { z } from 'zod';

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
  POSTGRES_API_RUNTIME_USER: z.string().default('pertexo_api'),
  POSTGRES_DISPATCHER_RUNTIME_USER: z.string().default('pertexo_dispatcher'),
  POSTGRES_LIFECYCLE_COMMAND_USER: z
    .string()
    .default('pertexo_lifecycle_command'),
  POSTGRES_MAINTENANCE_USER: z.string().default('pertexo_maintenance'),
  POSTGRES_MIGRATION_USER: z.string().default('pertexo_migration'),
  POSTGRES_OPERATOR_USER: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/u)
    .default('pertexo_operator'),
  POSTGRES_OWNER_USER: z.string().default('pertexo_owner'),
  POSTGRES_WORKER_RUNTIME_USER: z.string().default('pertexo_worker'),
  SERVICE_VERSION: z.string().trim().min(1).default('0.0.0-dev'),
});

const environmentSchema = z.discriminatedUnion('OPERATOR_COMMAND_TYPE', [
  baseEnvironmentSchema.extend({
    OPERATOR_COMMAND_TYPE: z.literal('outbox.redispatch'),
    OPERATOR_DRY_RUN: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true'),
    OPERATOR_OUTBOX_EVENT_ID: z.uuid(),
  }),
  baseEnvironmentSchema.extend({
    OPERATOR_COMMAND_TYPE: z.literal('operator.status'),
  }),
  baseEnvironmentSchema.extend({
    OPERATOR_ATTEMPT_ACTION: z.enum(['reclaim', 'outcome_unknown']),
    OPERATOR_ATTEMPT_ID: z.uuid(),
    OPERATOR_COMMAND_TYPE: z.literal('attempt.reconcile'),
    OPERATOR_DRY_RUN: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true'),
    OPERATOR_EXPECTED_FENCE_TOKEN: z.coerce.number().int().positive(),
  }),
  baseEnvironmentSchema.extend({
    OPERATOR_COMMAND_TYPE: z.literal('due-work.resume'),
    OPERATOR_DRY_RUN: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true'),
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
        context.addIssue({ code: 'custom', message: 'Invalid evidence JSON' });
        return z.NEVER;
      }
    }),
  }),
  baseEnvironmentSchema.extend({
    OPERATOR_COMMAND_TYPE: z.literal('run.cancel'),
    OPERATOR_DRY_RUN: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true'),
    OPERATOR_RUN_ID: z.uuid(),
  }),
  baseEnvironmentSchema.extend({
    OPERATOR_COMMAND_TYPE: z.literal('run.replay'),
    OPERATOR_DRY_RUN: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true'),
    OPERATOR_RUN_INPUT: z.string().transform((value, context) => {
      try {
        const parsed = z.json().parse(JSON.parse(value));
        if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > 65_536)
          throw new Error('Input is too large');
        return parsed;
      } catch {
        context.addIssue({ code: 'custom', message: 'Invalid run input JSON' });
        return z.NEVER;
      }
    }),
    OPERATOR_RUN_ID: z.uuid(),
    OPERATOR_WORKFLOW_VERSION_ID: z.uuid(),
  }),
  baseEnvironmentSchema.extend({
    OPERATOR_COMMAND_TYPE: z.literal('trigger.reconcile'),
    OPERATOR_DRY_RUN: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true'),
    OPERATOR_WORKFLOW_ID: z.uuid(),
  }),
]);

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
  readonly operatorRole: string;
  readonly forbiddenRoles: readonly string[];
  readonly timeoutMs: number;
}

export function parseOperatorCommandConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): OperatorCommandConfig {
  const parsed = environmentSchema.parse(environment);
  const database = parseOperatorDatabaseConfig(environment);
  return Object.freeze({
    command: (() => {
      switch (parsed.OPERATOR_COMMAND_TYPE) {
        case 'operator.status':
          return Object.freeze({
            actorRef: parsed.OPERATOR_ACTOR_REF,
            commandId: parsed.OPERATOR_COMMAND_ID,
            reason: parsed.OPERATOR_REASON,
            type: parsed.OPERATOR_COMMAND_TYPE,
            workspaceId: parsed.OPERATOR_WORKSPACE_ID,
          });
        case 'outbox.redispatch':
          return Object.freeze({
            actorRef: parsed.OPERATOR_ACTOR_REF,
            commandId: parsed.OPERATOR_COMMAND_ID,
            dryRun: parsed.OPERATOR_DRY_RUN,
            outboxEventId: parsed.OPERATOR_OUTBOX_EVENT_ID,
            reason: parsed.OPERATOR_REASON,
            type: parsed.OPERATOR_COMMAND_TYPE,
            workspaceId: parsed.OPERATOR_WORKSPACE_ID,
          });
        case 'attempt.reconcile':
          return Object.freeze({
            action: parsed.OPERATOR_ATTEMPT_ACTION,
            actorRef: parsed.OPERATOR_ACTOR_REF,
            attemptId: parsed.OPERATOR_ATTEMPT_ID,
            commandId: parsed.OPERATOR_COMMAND_ID,
            dryRun: parsed.OPERATOR_DRY_RUN,
            expectedFenceToken: parsed.OPERATOR_EXPECTED_FENCE_TOKEN,
            reason: parsed.OPERATOR_REASON,
            type: parsed.OPERATOR_COMMAND_TYPE,
            workspaceId: parsed.OPERATOR_WORKSPACE_ID,
          });
        case 'due-work.resume':
        case 'run.cancel':
          return Object.freeze({
            actorRef: parsed.OPERATOR_ACTOR_REF,
            commandId: parsed.OPERATOR_COMMAND_ID,
            dryRun: parsed.OPERATOR_DRY_RUN,
            reason: parsed.OPERATOR_REASON,
            runId: parsed.OPERATOR_RUN_ID,
            type: parsed.OPERATOR_COMMAND_TYPE,
            workspaceId: parsed.OPERATOR_WORKSPACE_ID,
          });
        case 'unknown-outcome.record-evidence':
          return Object.freeze({
            actorRef: parsed.OPERATOR_ACTOR_REF,
            attemptId: parsed.OPERATOR_ATTEMPT_ID,
            commandId: parsed.OPERATOR_COMMAND_ID,
            evidenceKind: parsed.OPERATOR_EVIDENCE_KIND,
            evidenceRef: Object.freeze(parsed.OPERATOR_EVIDENCE_REF),
            reason: parsed.OPERATOR_REASON,
            type: parsed.OPERATOR_COMMAND_TYPE,
            workspaceId: parsed.OPERATOR_WORKSPACE_ID,
          });
        case 'trigger.reconcile':
          return Object.freeze({
            actorRef: parsed.OPERATOR_ACTOR_REF,
            commandId: parsed.OPERATOR_COMMAND_ID,
            dryRun: parsed.OPERATOR_DRY_RUN,
            reason: parsed.OPERATOR_REASON,
            type: parsed.OPERATOR_COMMAND_TYPE,
            workflowId: parsed.OPERATOR_WORKFLOW_ID,
            workspaceId: parsed.OPERATOR_WORKSPACE_ID,
          });
        case 'run.replay':
          return Object.freeze({
            actorRef: parsed.OPERATOR_ACTOR_REF,
            commandId: parsed.OPERATOR_COMMAND_ID,
            dryRun: parsed.OPERATOR_DRY_RUN,
            reason: parsed.OPERATOR_REASON,
            runInput: parsed.OPERATOR_RUN_INPUT,
            sourceRunId: parsed.OPERATOR_RUN_ID,
            type: parsed.OPERATOR_COMMAND_TYPE,
            workflowVersionId: parsed.OPERATOR_WORKFLOW_VERSION_ID,
            workspaceId: parsed.OPERATOR_WORKSPACE_ID,
          });
      }
    })(),
    database,
    forbiddenRoles: Object.freeze([
      parsed.POSTGRES_API_RUNTIME_USER,
      parsed.POSTGRES_DISPATCHER_RUNTIME_USER,
      parsed.POSTGRES_LIFECYCLE_COMMAND_USER,
      parsed.POSTGRES_MAINTENANCE_USER,
      parsed.POSTGRES_MIGRATION_USER,
      parsed.POSTGRES_OWNER_USER,
      parsed.POSTGRES_WORKER_RUNTIME_USER,
    ]),
    observability: parseObservabilityConfig({
      environment: parsed.NODE_ENV,
      logLevel: parsed.LOG_LEVEL,
      ...(parsed.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
        ? {}
        : { otlpHttpEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT }),
      serviceName: 'pertexo-operator-command',
      serviceVersion: parsed.SERVICE_VERSION,
    }),
    operatorRole: database.operatorRole,
    timeoutMs: parsed.OPERATOR_TIMEOUT_MS,
  });
}
