import { fileURLToPath } from 'node:url';

import type { OperatorCommandDatabase } from '@pertexo/database/operator';
import type * as OperatorDatabaseModule from '@pertexo/database/operator';
import type { StructuredLogger } from '@pertexo/observability/logging';
import type * as LoggingModule from '@pertexo/observability/logging';
import { createTelemetryLifecycle } from '@pertexo/observability/telemetry';
import { classifyProcessError } from '@pertexo/observability/process-error-classification';

import type * as OperatorRunModule from './run.js';
import {
  parseOperatorCommandConfig,
  type OperatorCommandConfig,
} from './config.js';

type ShutdownSignal = 'SIGINT' | 'SIGTERM';

interface OperatorCommandProcess {
  once(signal: ShutdownSignal, listener: () => void): unknown;
  removeListener(signal: ShutdownSignal, listener: () => void): unknown;
  readonly stdout: { write(value: string): unknown };
}

export interface OperatorCommandBootstrapModules {
  readonly command: Pick<typeof OperatorRunModule, 'runOperatorCommand'>;
  readonly database: Pick<
    typeof OperatorDatabaseModule,
    'createOperatorCommandDatabase'
  >;
  readonly logging: Pick<typeof LoggingModule, 'createStructuredLogger'>;
}

export interface OperatorCommandBootstrapDependencies {
  readonly config?: OperatorCommandConfig;
  readonly createTelemetryLifecycle?: typeof createTelemetryLifecycle;
  readonly loadModules?: () => Promise<OperatorCommandBootstrapModules>;
  readonly process?: OperatorCommandProcess;
}

async function loadModules(): Promise<OperatorCommandBootstrapModules> {
  const [database, logging, command] = await Promise.all([
    import('@pertexo/database/operator'),
    import('@pertexo/observability/logging'),
    import('./run.js'),
  ]);
  return { command, database, logging };
}

function reportDiagnostic(report: (() => void) | undefined): void {
  try {
    report?.();
  } catch {
    // Process stderr remains the last-resort diagnostic owner.
  }
}

export async function bootstrapOperatorCommand(
  dependencies: OperatorCommandBootstrapDependencies = {},
): Promise<void> {
  const config = dependencies.config ?? parseOperatorCommandConfig();
  const telemetry = (
    dependencies.createTelemetryLifecycle ?? createTelemetryLifecycle
  )(config.observability);
  const shutdown = new AbortController();
  const stop = (): void => {
    shutdown.abort(new Error('Operator command interrupted'));
  };
  const processRuntime = dependencies.process ?? process;
  processRuntime.once('SIGINT', stop);
  processRuntime.once('SIGTERM', stop);
  let database: OperatorCommandDatabase | undefined;
  let logger: StructuredLogger | undefined;
  let commandInvoked = false;
  try {
    telemetry.start();
    const modules = await (dependencies.loadModules ?? loadModules)();
    logger = modules.logging.createStructuredLogger(config.observability);
    database = modules.database.createOperatorCommandDatabase(
      config.database,
      config.operatorRole,
      {
        forbiddenRoles: config.forbiddenRoles,
        lockTimeoutMs: config.timeoutMs,
        statementTimeoutMs: config.timeoutMs,
      },
    );
    const commandResources = {
      command: config.command,
      cleanupTimeoutMs: Math.min(config.timeoutMs, 10_000),
      database,
      logger,
      signal: AbortSignal.any([
        shutdown.signal,
        AbortSignal.timeout(config.timeoutMs),
      ]),
      telemetry,
    };
    commandInvoked = true;
    const result = await modules.command.runOperatorCommand(commandResources);
    processRuntime.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error: unknown) {
    reportDiagnostic(() =>
      logger?.fatal(
        'operator_command.bootstrap_failed',
        { errorType: classifyProcessError(error) },
        error,
      ),
    );
    if (!commandInvoked) {
      try {
        await database?.close();
      } catch {
        // The initiating bootstrap failure remains authoritative.
      }
      try {
        await telemetry.shutdown();
      } catch {
        // The initiating bootstrap failure remains authoritative.
      }
    }
    throw error;
  } finally {
    processRuntime.removeListener('SIGINT', stop);
    processRuntime.removeListener('SIGTERM', stop);
  }
}

function isMainModule(): boolean {
  return (
    process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === process.argv[1]
  );
}

if (isMainModule()) {
  void bootstrapOperatorCommand().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        errorType: classifyProcessError(error),
        event: 'operator_command.process_failed',
        level: 'fatal',
      })}\n`,
    );
    process.exitCode = 1;
  });
}
