import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';

import { ConnectionsController } from './controllers.js';
import { FailureNotificationDestinationsController } from './failure-notification-destinations.controller.js';
import { FailureNotificationDestinationUseCases } from './failure-notification-destinations.js';
import {
  ConnectionManageGuard,
  ConnectionReadGuard,
  ConnectionUseGuard,
  FailureNotificationWorkflowEditGuard,
} from './guards.js';
import type { ConnectionDependencies } from './ports.js';
import { NOOP_CONNECTION_TELEMETRY } from './telemetry.js';
import { CONNECTION_AUTHORIZATION } from './tokens.js';
import {
  CreateConnectionUseCase,
  GetConnectionUseCase,
  ListConnectionsUseCase,
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
      {
        provide: CONNECTION_AUTHORIZATION,
        useValue: dependencies.authorization,
      },
      ConnectionManageGuard,
      ConnectionReadGuard,
      ConnectionUseGuard,
      FailureNotificationWorkflowEditGuard,
      {
        provide: ListConnectionsUseCase,
        useValue: new ListConnectionsUseCase(
          dependencies.persistence,
          dependencies.authorization,
          telemetry,
        ),
      },
      {
        provide: GetConnectionUseCase,
        useValue: new GetConnectionUseCase(
          dependencies.persistence,
          dependencies.authorization,
          telemetry,
        ),
      },
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
        ListConnectionsUseCase,
        GetConnectionUseCase,
        CreateConnectionUseCase,
        RotateConnectionSecretUseCase,
        RevokeConnectionUseCase,
        TestConnectionUseCase,
      ],
    };
  }
}
