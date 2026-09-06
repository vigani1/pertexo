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
import { ArtifactsController } from './controllers.js';
import { ArtifactReadGuard, ArtifactUploadGuard } from './guards.js';
import type { ArtifactDependencies } from './ports.js';
import { ArtifactService } from './service.js';
import {
  ARTIFACT_AUTHORIZATION,
  ARTIFACT_DATABASE,
  ARTIFACT_STORE,
} from './tokens.js';

@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ArtifactsModule {
  public static register(
    dependencies: ArtifactDependencies,
    identityModule: DynamicModule,
    options: Readonly<{ maxObjectBytes: number; now?: () => Date }>,
  ): DynamicModule {
    const providers: Provider[] = [
      { provide: ARTIFACT_DATABASE, useValue: dependencies.database },
      { provide: ARTIFACT_STORE, useValue: dependencies.store },
      { provide: ARTIFACT_AUTHORIZATION, useValue: dependencies.authorization },
      {
        provide: ArtifactService,
        useFactory: (
          database: ArtifactDependencies['database'],
          store: ArtifactDependencies['store'],
          authorization: ArtifactDependencies['authorization'],
        ) => new ArtifactService({ database, store, authorization }, options),
        inject: [ARTIFACT_DATABASE, ARTIFACT_STORE, ARTIFACT_AUTHORIZATION],
      },
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
      ArtifactUploadGuard,
      ArtifactReadGuard,
    ];
    return {
      module: ArtifactsModule,
      imports: [identityModule],
      controllers: [ArtifactsController],
      providers,
      exports: [ArtifactService],
    };
  }
}
