import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';

import { CatalogController } from './controllers.js';
import type { CatalogDependencies } from './use-cases.js';
import {
  createCatalogUseCases,
  ListIntegrationsUseCase,
  ListNodeDefinitionsUseCase,
} from './use-cases.js';

@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class CatalogModule {
  public static register(
    dependencies: CatalogDependencies,
    identityModule: DynamicModule,
  ): DynamicModule {
    const useCases = createCatalogUseCases(dependencies);
    const providers: Provider[] = [
      {
        provide: ListNodeDefinitionsUseCase,
        useValue: useCases.listNodeDefinitions,
      },
      {
        provide: ListIntegrationsUseCase,
        useValue: useCases.listIntegrations,
      },
    ];
    return {
      module: CatalogModule,
      imports: [identityModule],
      controllers: [CatalogController],
      providers,
    };
  }
}
