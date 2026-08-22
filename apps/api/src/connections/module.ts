import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';

import {
  DoubleSubmitCsrfPolicy,
  OpaqueSessionService,
} from '../identity/index.js';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../identity-workspace/guards.js';
import { RequestContextStore } from '../platform/http/index.js';
import { ConnectionsController } from './controllers.js';
import { ConnectionManageGuard, ConnectionUseGuard } from './guards.js';
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
      {
        provide: SessionAuthenticationGuard,
        useFactory: (
          sessions: OpaqueSessionService,
          contexts: RequestContextStore,
        ) => new SessionAuthenticationGuard(sessions, contexts),
        inject: [OpaqueSessionService, RequestContextStore],
      },
      {
        provide: CsrfProtectionGuard,
        useFactory: (csrf: DoubleSubmitCsrfPolicy) =>
          new CsrfProtectionGuard(csrf),
        inject: [DoubleSubmitCsrfPolicy],
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
        ),
      },
    ];
    return {
      module: ConnectionsModule,
      imports: [identityModule],
      controllers: [ConnectionsController],
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
