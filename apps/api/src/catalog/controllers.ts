import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { catalogQuerySchema } from '@pertexo/contracts/catalog';

import { SessionAuthenticationGuard } from '../identity-workspace/index.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import {
  ListIntegrationsUseCase,
  ListNodeDefinitionsUseCase,
} from './use-cases.js';

@Controller('v1')
export class CatalogController {
  public constructor(
    private readonly listNodeDefinitionsUseCase: ListNodeDefinitionsUseCase,
    private readonly listIntegrationsUseCase: ListIntegrationsUseCase,
  ) {}

  @Get('node-definitions')
  @RateLimit('authenticated_read')
  @UseGuards(SessionAuthenticationGuard)
  public listNodeDefinitions(@Query() query: unknown = {}) {
    catalogQuerySchema.parse(query ?? {});
    return this.listNodeDefinitionsUseCase.execute();
  }

  @Get('integrations')
  @RateLimit('authenticated_read')
  @UseGuards(SessionAuthenticationGuard)
  public listIntegrations(@Query() query: unknown = {}) {
    catalogQuerySchema.parse(query ?? {});
    return this.listIntegrationsUseCase.execute();
  }
}
