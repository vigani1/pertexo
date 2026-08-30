import { Controller, Get } from '@nestjs/common';

import { RateLimitExempt } from '../rate-limit/metadata.js';

type LivenessResponse = Readonly<{
  status: 'ok';
}>;

const LIVENESS_RESPONSE: LivenessResponse = Object.freeze({ status: 'ok' });

@Controller('health')
@RateLimitExempt()
export class LiveController {
  @Get('live')
  live(): LivenessResponse {
    return LIVENESS_RESPONSE;
  }
}
