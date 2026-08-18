import 'reflect-metadata';

import { Module } from '@nestjs/common';

import { LiveController } from './platform/health/live.controller.js';

@Module({
  controllers: [LiveController],
})
// Nest requires a class as the root module passed to the application factory.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AppModule {}
