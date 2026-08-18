import { Controller, Get } from '@nestjs/common';

type LivenessResponse = Readonly<{
  status: 'ok';
}>;

const LIVENESS_RESPONSE: LivenessResponse = Object.freeze({ status: 'ok' });

@Controller('health')
export class LiveController {
  @Get('live')
  live(): LivenessResponse {
    return LIVENESS_RESPONSE;
  }
}
