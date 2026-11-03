import { Controller, Get, Header } from '@nestjs/common';
import { publicOpenApiDocument } from '@pertexo/contracts/server';

import { RateLimitExempt } from '../rate-limit/metadata.js';

/** The public API's spec, for a client generator or a reference viewer. */
@Controller('v1/openapi.json')
@RateLimitExempt()
export class PublicApiController {
  @Get()
  @Header('Cache-Control', 'public, max-age=300')
  read() {
    return publicOpenApiDocument;
  }
}
