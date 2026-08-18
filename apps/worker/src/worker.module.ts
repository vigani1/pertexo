import 'reflect-metadata';

import { Module } from '@nestjs/common';

@Module({})
// Nest requires a class as the root module passed to the application factory.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class WorkerModule {}
