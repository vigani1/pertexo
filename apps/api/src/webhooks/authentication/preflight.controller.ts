import { Controller, Inject, Options, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import type { createWebhookPreflight } from '../ingress.js';
import { WEBHOOK_PREFLIGHT } from '../tokens.js';

@Controller('hooks')
export class WebhookPreflightController {
  public constructor(
    @Inject(WEBHOOK_PREFLIGHT)
    private readonly preflight: ReturnType<typeof createWebhookPreflight>,
  ) {}

  @Options(':endpointKey/test')
  @RateLimit('webhook_preflight')
  public test(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    return this.preflight(request, reply);
  }

  @Options(':endpointKey')
  @RateLimit('webhook_preflight')
  public handle(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    return this.preflight(request, reply);
  }
}
