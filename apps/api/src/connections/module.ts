import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';

import { ConnectionsController } from './controllers.js';
import {
  FailureNotificationDestinationsController,
  FailureNotificationDestinationUseCases,
} from './failure-notification-destinations.js';
import {
  ConnectionManageGuard,
  ConnectionUseGuard,
  FailureNotificationWorkflowEditGuard,
} from './guards.js';
import type { ConnectionDependencies } from './ports.js';
import { NOOP_CONNECTION_TELEMETRY } from './telemetry.js';
import {
  CONNECTION_AUTHORIZATION,
  CONNECTION_ENCRYPTION,
  CONNECTION_PERSISTENCE,
  CONNECTION_TELEMETRY,
} from './tokens.js';
import {
  CreateConnectionUseCase,
  RevokeConnectionUseCase,
  RotateConnectionSecretUseCase,
  TestConnectionUseCase,
} from './use-cases.js';

@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ConnectionsModule {
  public static register(
    dependencies: ConnectionDependencies,
    identityModule: DynamicModule,
  ): DynamicModule {
    const telemetry = dependencies.telemetry ?? NOOP_CONNECTION_TELEMETRY;
    const providers: Provider[] = [
      { provide: CONNECTION_PERSISTENCE, useValue: dependencies.persistence },
      {
        provide: CONNECTION_AUTHORIZATION,
        useValue: dependencies.authorization,
      },
      { provide: CONNECTION_ENCRYPTION, useValue: dependencies.encryption },
      { provide: CONNECTION_TELEMETRY, useValue: telemetry },
      ConnectionManageGuard,
      ConnectionUseGuard,
      FailureNotificationWorkflowEditGuard,
      {
        provide: CreateConnectionUseCase,
        useValue: new CreateConnectionUseCase(
          dependencies.persistence,
          dependencies.authorization,
          dependencies.encryption,
          telemetry,
        ),
      },
      {
        provide: RotateConnectionSecretUseCase,
        useValue: new RotateConnectionSecretUseCase(
          dependencies.persistence,
          dependencies.authorization,
          dependencies.encryption,
          telemetry,
        ),
      },
      {
        provide: RevokeConnectionUseCase,
        useValue: new RevokeConnectionUseCase(
          dependencies.persistence,
          dependencies.authorization,
          telemetry,
        ),
      },
      {
        provide: TestConnectionUseCase,
        useValue: new TestConnectionUseCase(
          dependencies.persistence,
          dependencies.authorization,
          dependencies.encryption,
          dependencies.httpClient,
          telemetry,
          dependencies.slackClient,
          dependencies.emailClient,
        ),
      },
    ];
    if (dependencies.destinationPersistence !== undefined)
      providers.push({
        provide: FailureNotificationDestinationUseCases,
        useValue: new FailureNotificationDestinationUseCases(
          dependencies.destinationPersistence,
          telemetry,
        ),
      });
    return {
      module: ConnectionsModule,
      imports: [identityModule],
      controllers: [
        ConnectionsController,
        ...(dependencies.destinationPersistence === undefined
          ? []
          : [FailureNotificationDestinationsController]),
      ],
      providers,
      exports: [
        CreateConnectionUseCase,
        RotateConnectionSecretUseCase,
        RevokeConnectionUseCase,
        TestConnectionUseCase,
      ],
    };
  }
}
