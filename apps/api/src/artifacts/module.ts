import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';

import {
  ArtifactsController,
  UnconfiguredArtifactsController,
} from './controllers.js';
import {
  ArtifactReadGuard,
  ArtifactUploadGuard,
  FormResponderGuard,
  InputRequestResponderGuard,
} from './guards.js';
import { FormUploadService } from './form-uploads/service.js';
import { PublicFormUploadsController } from './form-uploads/public.controller.js';
import { MemberFormUploadsController } from './form-uploads/members.controller.js';
import { InputRequestUploadsController } from './form-uploads/tasks.controller.js';
import { UnconfiguredFormUploadsController } from './form-uploads/unavailable.controller.js';
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
  public static registerUnavailable(
    authorization: ArtifactDependencies['authorization'],
    identityModule: DynamicModule,
  ): DynamicModule {
    return {
      module: ArtifactsModule,
      imports: [identityModule],
      controllers: [
        UnconfiguredArtifactsController,
        UnconfiguredFormUploadsController,
      ],
      providers: [
        { provide: ARTIFACT_AUTHORIZATION, useValue: authorization },
        ArtifactUploadGuard,
        ArtifactReadGuard,
      ],
    };
  }

  public static register(
    dependencies: ArtifactDependencies,
    modules: Readonly<{ identity: DynamicModule; admission: DynamicModule }>,
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
        provide: FormUploadService,
        useValue: new FormUploadService(
          { database: dependencies.formUploads, store: dependencies.store },
          options,
        ),
      },
      ArtifactUploadGuard,
      ArtifactReadGuard,
      FormResponderGuard,
      InputRequestResponderGuard,
    ];
    return {
      module: ArtifactsModule,
      imports: [modules.identity, modules.admission],
      controllers: [
        ArtifactsController,
        PublicFormUploadsController,
        MemberFormUploadsController,
        InputRequestUploadsController,
      ],
      providers,
      exports: [ArtifactService],
    };
  }
}
