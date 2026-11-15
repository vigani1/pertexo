import { Controller } from '@nestjs/common';
import { catalogRoutes as routes } from '@pertexo/contracts/server';

import { Route } from '../platform/http/route.js';
import {
  ListIntegrationsService,
  ListNodeDefinitionsService,
} from './catalog.service.js';

@Controller()
export class CatalogController {
  public constructor(
    private readonly listNodeDefinitionsService: ListNodeDefinitionsService,
    private readonly listIntegrationsService: ListIntegrationsService,
  ) {}

  @Route(routes.nodeDefinitions)
  public listNodeDefinitions() {
    return this.listNodeDefinitionsService.execute();
  }

  @Route(routes.integrations)
  public listIntegrations() {
    return this.listIntegrationsService.execute();
  }
}
