import { ConnectionSharingController } from './sharing/connection-sharing.controller.js';
import { ConnectionSharingServices } from './sharing/connection-sharing.service.js';
import { UnconfiguredConnectionsController } from './http/unavailable.controller.js';
import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';
import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';

import { ConnectionsController } from './http/connections.controller.js';
import { ConnectionOAuth2Controller } from './oauth2/connection-o-auth2.controller.js';
import { FinishOAuth2AuthorizationService } from './oauth2/finish-authorization.js';
import { StartOAuth2AuthorizationService } from './oauth2/start-authorization.js';
import { ConnectionUsageController } from './http/usage.controller.js';
import { ListConnectionUsageService } from './management/connection-usage.js';
import { FailureNotificationDestinationsController } from './failure-notifications/failure-notification-destinations.controller.js';
import { FailureNotificationDestinationServices } from './failure-notifications/destinations.js';
import type { ConnectionDependencies } from './ports.js';
import {
  NOOP_CONNECTION_TELEMETRY,
  type ConnectionTelemetry,
} from './telemetry.js';
import { WORKSPACE_AUTHORIZATION } from '../workspaces/tokens.js';
import {
  CreateConnectionService,
  GetConnectionService,
  ListConnectionsService,
  RevokeConnectionService,
  RotateConnectionSecretService,
} from './management/connection-management.js';
import { LookupSlackChannelsService } from './failure-notifications/slack-channel-lookup.js';
import { TestConnectionService } from './testing/test-connection.js';

function oauth2Providers({
  oauth2,
  authorization,
  encryption,
  applicationSecret,
}: ConnectionDependencies): readonly Provider[] {
  if (oauth2 === undefined) return [];
  return [
    {
      provide: StartOAuth2AuthorizationService,
      useValue: new StartOAuth2AuthorizationService(
        oauth2,
        authorization,
        encryption,
        applicationSecret,
      ),
    },
    {
      provide: FinishOAuth2AuthorizationService,
      useValue: new FinishOAuth2AuthorizationService(
        oauth2,
        encryption,
        applicationSecret,
      ),
    },
  ];
}

/** The usual three arguments of a service that only reads and answers. */
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
        { provide: WORKSPACE_AUTHORIZATION, useValue: authorization },
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
        provide: WORKSPACE_AUTHORIZATION,
        useValue: dependencies.authorization,
      },
      {
        provide: ListConnectionsService,
        useValue: new ListConnectionsService(
          ...answering(dependencies, telemetry),
        ),
      },
      {
        provide: GetConnectionService,
        useValue: new GetConnectionService(
          ...answering(dependencies, telemetry),
        ),
      },
      {
        provide: CreateConnectionService,
        useValue: new CreateConnectionService(
          dependencies.persistence,
          dependencies.authorization,
          {
            encryption: dependencies.encryption,
            applicationSecret: dependencies.applicationSecret,
            telemetry: telemetry,
            oauth2: dependencies.oauth2,
            smtpPolicy: dependencies.smtpPolicy,
          },
        ),
      },
      {
        provide: RotateConnectionSecretService,
        useValue: new RotateConnectionSecretService(
          dependencies.persistence,
          dependencies.authorization,
          {
            encryption: dependencies.encryption,
            applicationSecret: dependencies.applicationSecret,
            telemetry: telemetry,
            oauth2: dependencies.oauth2,
            smtpPolicy: dependencies.smtpPolicy,
          },
        ),
      },
      {
        provide: RevokeConnectionService,
        useValue: new RevokeConnectionService(
          ...answering(dependencies, telemetry),
        ),
      },
      {
        provide: TestConnectionService,
        useValue: new TestConnectionService(
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
            smtpPolicy: dependencies.smtpPolicy,
          },
        ),
      },
      {
        provide: LookupSlackChannelsService,
        useValue: new LookupSlackChannelsService(
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
        provide: ConnectionSharingServices,
        useValue: new ConnectionSharingServices(
          dependencies.sharingPersistence,
          dependencies.authorization,
          telemetry,
        ),
      });
    if (dependencies.destinationPersistence !== undefined)
      providers.push({
        provide: FailureNotificationDestinationServices,
        useValue: new FailureNotificationDestinationServices(
          dependencies.destinationPersistence,
          dependencies.applicationSecret,
          telemetry,
          dependencies.systemMailAvailable,
        ),
      });
    if (dependencies.usagePersistence !== undefined)
      providers.push({
        provide: ListConnectionUsageService,
        useValue: new ListConnectionUsageService(
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
        ListConnectionsService,
        GetConnectionService,
        CreateConnectionService,
        RotateConnectionSecretService,
        RevokeConnectionService,
        TestConnectionService,
        LookupSlackChannelsService,
      ],
    };
  }
}
