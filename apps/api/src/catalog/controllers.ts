import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { catalogQuerySchema } from '@pertexo/contracts';

import { SessionAuthenticationGuard } from '../workspaces/index.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import {
  ListIntegrationsUseCase,
  ListNodeDefinitionsUseCase,
} from './use-cases.js';
import { parseRequestInput } from '../platform/http/request-input.js';

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
    parseRequestInput(catalogQuerySchema, query ?? {});
    return this.listNodeDefinitionsUseCase.execute();
  }

  @Get('integrations')
  @RateLimit('authenticated_read')
  @UseGuards(SessionAuthenticationGuard)
  public listIntegrations(@Query() query: unknown = {}) {
    parseRequestInput(catalogQuerySchema, query ?? {});
    return this.listIntegrationsUseCase.execute();
  }
}
