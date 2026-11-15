import { DEFAULT_CODE_SETTINGS, type CodeSettings } from '@pertexo/node-sdk';
import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';

import { CatalogController } from './catalog.controller.js';
import {
  createCatalogServices,
  ListIntegrationsService,
  ListNodeDefinitionsService,
} from './catalog.service.js';

@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class CatalogModule {
  public static register(
    identityModule: DynamicModule,
    codeSettings: CodeSettings = DEFAULT_CODE_SETTINGS,
  ): DynamicModule {
    const services = createCatalogServices(codeSettings);
    const providers: Provider[] = [
      {
        provide: ListNodeDefinitionsService,
        useValue: services.listNodeDefinitions,
      },
      {
        provide: ListIntegrationsService,
        useValue: services.listIntegrations,
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
