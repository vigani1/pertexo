import { Controller, Get } from '@nestjs/common';

import { RateLimitExempt } from '../rate-limit/metadata.js';
import { HEALTH_PATHS } from './health-paths.js';

type LivenessResponse = Readonly<{
  status: 'ok';
}>;

const LIVENESS_RESPONSE: LivenessResponse = Object.freeze({ status: 'ok' });

@Controller()
@RateLimitExempt()
export class LiveController {
  @Get(HEALTH_PATHS.live)
  live(): LivenessResponse {
    return LIVENESS_RESPONSE;
  }
}
