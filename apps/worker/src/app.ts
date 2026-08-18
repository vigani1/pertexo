import type { INestApplicationContext, LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { WorkspaceDatabase } from '@pertexo/database';

import type { WorkerConfig } from './config/worker-config.js';
import { WORKSPACE_DATABASE } from './platform/database/database.module.js';
import { WorkerModule } from './worker.module.js';

const nestLogLevelsByWorkerLogLevel = {
  fatal: ['fatal'],
  error: ['fatal', 'error'],
  warn: ['fatal', 'error', 'warn'],
  info: ['fatal', 'error', 'warn', 'log'],
  debug: ['fatal', 'error', 'warn', 'log', 'debug'],
  trace: ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'],
} as const satisfies Record<WorkerConfig['logLevel'], readonly LogLevel[]>;

export async function createWorkerApplication(
  config: WorkerConfig,
  database?: WorkspaceDatabase,
): Promise<INestApplicationContext> {
  const logger = [...nestLogLevelsByWorkerLogLevel[config.logLevel]];
  const application = await NestFactory.createApplicationContext(
    WorkerModule.register(config, database),
    { abortOnError: true, logger },
  );

  application.enableShutdownHooks();

  try {
    await application
      .get<WorkspaceDatabase>(WORKSPACE_DATABASE)
      .checkReadiness();
  } catch (error: unknown) {
    await application.close();
    throw error;
  }

  return application;
}
