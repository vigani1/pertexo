import { WORKSPACE_AUTHORIZATION } from '../workspaces/tokens.js';
import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';

import {
  ArtifactsController,
  UnconfiguredArtifactsController,
} from './controllers.js';
import { FormUploadService } from './form-uploads/service.js';
import { PublicFormUploadsController } from './form-uploads/public.controller.js';
import { MemberFormUploadsController } from './form-uploads/members.controller.js';
import { InputRequestUploadsController } from './form-uploads/tasks.controller.js';
import { UnconfiguredFormUploadsController } from './form-uploads/unavailable.controller.js';
import type { ArtifactDependencies } from './ports.js';
import { ArtifactService } from './service.js';

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
        { provide: WORKSPACE_AUTHORIZATION, useValue: authorization },
      ],
    };
  }

  public static register(
    dependencies: ArtifactDependencies,
    modules: Readonly<{ identity: DynamicModule; admission: DynamicModule }>,
    options: Readonly<{ maxObjectBytes: number; now?: () => Date }>,
  ): DynamicModule {
    const providers: Provider[] = [
      {
        provide: ArtifactService,
        useValue: new ArtifactService(
          {
            database: dependencies.database,
            store: dependencies.store,
            authorization: dependencies.authorization,
          },
          options,
        ),
      },
      {
        provide: FormUploadService,
        useValue: new FormUploadService(
          { database: dependencies.formUploads, store: dependencies.store },
          options,
        ),
      },
      {
        provide: WORKSPACE_AUTHORIZATION,
        useValue: dependencies.authorization,
      },
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
