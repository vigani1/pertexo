import type { OperatorCommandDatabase } from '@pertexo/database/operator';
import type { StructuredLogger } from '@pertexo/observability/logging';
import { createTelemetryLifecycle } from '@pertexo/observability/telemetry';

import { parseOperatorCommandConfig } from './config.js';

async function bootstrap(): Promise<void> {
  const config = parseOperatorCommandConfig();
  const telemetry = createTelemetryLifecycle(config.observability);
  const shutdown = new AbortController();
  const stop = (): void => {
    shutdown.abort(new Error('Operator command interrupted'));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let database: OperatorCommandDatabase | undefined;
  let logger: StructuredLogger | undefined;
  let commandInvoked = false;
  try {
    telemetry.start();
    const [databasePackage, logging, command] = await Promise.all([
      import('@pertexo/database/operator'),
      import('@pertexo/observability/logging'),
      import('./run.js'),
    ]);
    logger = logging.createStructuredLogger(config.observability);
    database = databasePackage.createOperatorCommandDatabase(
      config.database,
      config.operatorRole,
      {
        forbiddenRoles: config.forbiddenRoles,
        lockTimeoutMs: config.timeoutMs,
        statementTimeoutMs: config.timeoutMs,
      },
    );
    commandInvoked = true;
    const result = await command.runOperatorCommand({
      command: config.command,
      cleanupTimeoutMs: Math.min(config.timeoutMs, 10_000),
      database,
      logger,
      signal: AbortSignal.any([
        shutdown.signal,
        AbortSignal.timeout(config.timeoutMs),
      ]),
      telemetry,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error: unknown) {
    logger?.fatal(
      'operator_command.bootstrap_failed',
      { errorType: error instanceof Error ? error.name : typeof error },
      error,
    );
    if (!commandInvoked) {
      await database?.close().catch(() => undefined);
      await telemetry.shutdown().catch(() => undefined);
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

void bootstrap().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      errorType: error instanceof Error ? error.name : typeof error,
      event: 'operator_command.process_failed',
      level: 'fatal',
    })}\n`,
  );
  process.exitCode = 1;
});
