import type { WorkspaceDatabase } from '@pertexo/database';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module.js';
import type { ApiConfig } from './platform/config/api-config.js';

export async function createApiApplication(
  config: ApiConfig,
  database?: WorkspaceDatabase,
): Promise<NestFastifyApplication> {
  const application = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(config, database),
    new FastifyAdapter(),
    { bufferLogs: true },
  );

  application.enableShutdownHooks();

  return application;
}
