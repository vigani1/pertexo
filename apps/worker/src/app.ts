import type { INestApplicationContext, LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import type { WorkerConfig } from './config/worker-config.js';
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
): Promise<INestApplicationContext> {
  const logger = [...nestLogLevelsByWorkerLogLevel[config.logLevel]];
  const application = await NestFactory.createApplicationContext(WorkerModule, {
    abortOnError: true,
    logger,
  });

  application.enableShutdownHooks();

  return application;
}
