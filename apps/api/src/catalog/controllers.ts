import { Controller } from '@nestjs/common';
import { catalogRoutes as routes } from '@pertexo/contracts/server';

import { Route } from '../workspaces/http/route.js';
import {
  ListIntegrationsUseCase,
  ListNodeDefinitionsUseCase,
} from './catalog.service.js';

@Controller()
export class CatalogController {
  public constructor(
    private readonly listNodeDefinitionsUseCase: ListNodeDefinitionsUseCase,
    private readonly listIntegrationsUseCase: ListIntegrationsUseCase,
  ) {}

  @Route(routes.nodeDefinitions)
  public listNodeDefinitions() {
    return this.listNodeDefinitionsUseCase.execute();
  }

  @Route(routes.integrations)
  public listIntegrations() {
    return this.listIntegrationsUseCase.execute();
  }
}
