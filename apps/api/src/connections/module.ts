import { ConnectionSharingController } from './sharing/controller.js';
import { ConnectionSharingUseCases } from './sharing/use-case.js';
import { UnconfiguredConnectionsController } from './http/unavailable.js';
import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';
import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';

import { ConnectionsController } from './http/controllers.js';
import { ConnectionOAuth2Controller } from './oauth2/controller.js';
import { FinishOAuth2AuthorizationUseCase } from './oauth2/finish-authorization.js';
import { StartOAuth2AuthorizationUseCase } from './oauth2/start-authorization.js';
import {
  ConnectionUsageController,
  ListConnectionUsageUseCase,
} from './use-cases/usage.js';
import { FailureNotificationDestinationsController } from './failure-notifications/controller.js';
import { FailureNotificationDestinationUseCases } from './failure-notifications/destinations.js';
import {
  ConnectionManageGuard,
  ConnectionReadGuard,
  ConnectionUseGuard,
  FailureNotificationWorkflowEditGuard,
} from './http/guards.js';
import type { ConnectionDependencies } from './ports.js';
import {
  NOOP_CONNECTION_TELEMETRY,
  type ConnectionTelemetry,
} from './telemetry.js';
import { CONNECTION_AUTHORIZATION } from './tokens.js';
import {
  CreateConnectionUseCase,
  GetConnectionUseCase,
  ListConnectionsUseCase,
  LookupSlackChannelsUseCase,
  RevokeConnectionUseCase,
  RotateConnectionSecretUseCase,
  TestConnectionUseCase,
} from './use-cases/management.js';

function oauth2Providers({
  oauth2,
  authorization,
  encryption,
  applicationSecret,
}: ConnectionDependencies): readonly Provider[] {
  if (oauth2 === undefined) return [];
  return [
    {
      provide: StartOAuth2AuthorizationUseCase,
      useValue: new StartOAuth2AuthorizationUseCase(
        oauth2,
        authorization,
        encryption,
        applicationSecret,
      ),
    },
    {
      provide: FinishOAuth2AuthorizationUseCase,
      useValue: new FinishOAuth2AuthorizationUseCase(
        oauth2,
        encryption,
        applicationSecret,
      ),
    },
  ];
}

/** The usual three arguments of a use case that only reads and answers. */
const answering = (
  dependencies: ConnectionDependencies,
  telemetry: ConnectionTelemetry,
) =>
  [
    dependencies.persistence,
    dependencies.authorization,
    telemetry,
    dependencies.oauth2,
  ] as const;

@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ConnectionsModule {
  public static registerUnavailable(
    authorization: WorkspaceAuthorizationSource,
    identityModule: DynamicModule,
  ): DynamicModule {
    return {
      module: ConnectionsModule,
      imports: [identityModule],
      controllers: [UnconfiguredConnectionsController],
      providers: [
        { provide: CONNECTION_AUTHORIZATION, useValue: authorization },
        ConnectionReadGuard,
        FailureNotificationWorkflowEditGuard,
      ],
    };
  }

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
          ...answering(dependencies, telemetry),
        ),
      },
      {
        provide: GetConnectionUseCase,
        useValue: new GetConnectionUseCase(
          ...answering(dependencies, telemetry),
        ),
      },
      {
        provide: CreateConnectionUseCase,
        useValue: new CreateConnectionUseCase(
          dependencies.persistence,
          dependencies.authorization,
          {
            encryption: dependencies.encryption,
            applicationSecret: dependencies.applicationSecret,
            telemetry: telemetry,
            oauth2: dependencies.oauth2,
          },
        ),
      },
      {
        provide: RotateConnectionSecretUseCase,
        useValue: new RotateConnectionSecretUseCase(
          dependencies.persistence,
          dependencies.authorization,
          {
            encryption: dependencies.encryption,
            applicationSecret: dependencies.applicationSecret,
            telemetry: telemetry,
            oauth2: dependencies.oauth2,
          },
        ),
      },
      {
        provide: RevokeConnectionUseCase,
        useValue: new RevokeConnectionUseCase(
          ...answering(dependencies, telemetry),
        ),
      },
      {
        provide: TestConnectionUseCase,
        useValue: new TestConnectionUseCase(
          dependencies.persistence,
          dependencies.authorization,
          {
            encryption: dependencies.encryption,
            httpClient: dependencies.httpClient,
            applicationSecret: dependencies.applicationSecret,
            telemetry: telemetry,
            slackClient: dependencies.slackClient,
            emailClient: dependencies.emailClient,
            oauth2: dependencies.oauth2,
          },
        ),
      },
      {
        provide: LookupSlackChannelsUseCase,
        useValue: new LookupSlackChannelsUseCase(
          dependencies.persistence,
          dependencies.authorization,
          {
            encryption: dependencies.encryption,
            slackClient: dependencies.slackClient,
            telemetry: telemetry,
          },
        ),
      },
    ];
    providers.push(...oauth2Providers(dependencies));
    if (dependencies.sharingPersistence !== undefined)
      providers.push({
        provide: ConnectionSharingUseCases,
        useValue: new ConnectionSharingUseCases(
          dependencies.sharingPersistence,
          dependencies.authorization,
          telemetry,
        ),
      });
    if (dependencies.destinationPersistence !== undefined)
      providers.push({
        provide: FailureNotificationDestinationUseCases,
        useValue: new FailureNotificationDestinationUseCases(
          dependencies.destinationPersistence,
          dependencies.applicationSecret,
          telemetry,
        ),
      });
    if (dependencies.usagePersistence !== undefined)
      providers.push({
        provide: ListConnectionUsageUseCase,
        useValue: new ListConnectionUsageUseCase(
          dependencies.usagePersistence,
          dependencies.authorization,
          telemetry,
        ),
      });
    return {
      module: ConnectionsModule,
      imports: [identityModule],
      controllers: [
        ConnectionsController,
        ...(dependencies.oauth2 === undefined
          ? []
          : [ConnectionOAuth2Controller]),
        ...(dependencies.sharingPersistence === undefined
          ? []
          : [ConnectionSharingController]),
        ...(dependencies.usagePersistence === undefined
          ? []
          : [ConnectionUsageController]),
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
        LookupSlackChannelsUseCase,
      ],
    };
  }
}
