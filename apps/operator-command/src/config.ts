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
  OPERATOR_COMMAND_ID: z.uuid(),
  OPERATOR_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .default(30_000),
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
    OPERATOR_ACTOR_REF: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u),
    OPERATOR_COMMAND_TYPE: z.literal('outbox.redispatch'),
    OPERATOR_DRY_RUN: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true'),
    OPERATOR_OUTBOX_EVENT_ID: z.uuid(),
    OPERATOR_REASON: z.string().min(1).max(512),
    OPERATOR_WORKSPACE_ID: z.uuid(),
  }),
  baseEnvironmentSchema.extend({
    OPERATOR_ACTOR_REF: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u),
    OPERATOR_COMMAND_TYPE: z.literal('operator.status'),
    OPERATOR_REASON: z.string().min(1).max(512),
    OPERATOR_WORKSPACE_ID: z.uuid(),
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
        reason: string;
        type: 'operator.status';
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
    command:
      parsed.OPERATOR_COMMAND_TYPE === 'operator.status'
        ? Object.freeze({
            actorRef: parsed.OPERATOR_ACTOR_REF,
            commandId: parsed.OPERATOR_COMMAND_ID,
            reason: parsed.OPERATOR_REASON,
            type: parsed.OPERATOR_COMMAND_TYPE,
            workspaceId: parsed.OPERATOR_WORKSPACE_ID,
          })
        : Object.freeze({
            actorRef: parsed.OPERATOR_ACTOR_REF,
            commandId: parsed.OPERATOR_COMMAND_ID,
            dryRun: parsed.OPERATOR_DRY_RUN,
            outboxEventId: parsed.OPERATOR_OUTBOX_EVENT_ID,
            reason: parsed.OPERATOR_REASON,
            type: parsed.OPERATOR_COMMAND_TYPE,
            workspaceId: parsed.OPERATOR_WORKSPACE_ID,
          }),
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
