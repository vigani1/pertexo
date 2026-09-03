import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';
import {
  createNestObservabilityRegistration,
  NestLoggerAdapter,
} from '@pertexo/observability/nest-runtime';

export { NestLoggerAdapter };

const STRUCTURED_LOGGER = Symbol('STRUCTURED_LOGGER');
const TELEMETRY_LIFECYCLE = Symbol('TELEMETRY_LIFECYCLE');

@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ObservabilityModule {
  public static register(
    logger: StructuredLogger,
    telemetry: TelemetryLifecycle,
  ): DynamicModule {
    return createNestObservabilityRegistration({
      module: ObservabilityModule,
      loggerToken: STRUCTURED_LOGGER,
      telemetryToken: TELEMETRY_LIFECYCLE,
      logger,
      telemetry,
    });
  }
}
