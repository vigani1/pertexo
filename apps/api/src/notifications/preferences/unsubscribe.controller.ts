import { Body, Controller, Header, HttpCode, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { firstRequestHeader } from '../../platform/http/request-headers.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import { NoticePreferencesService } from './service.js';
@Controller('v1/notifications/unsubscribe')
@RateLimit('notice_unsubscribe')
export class NoticeUnsubscribeController {
  constructor(private readonly preferences: NoticePreferencesService) {}
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  unsubscribe(@Req() request: FastifyRequest, @Body() body: unknown) {
    z.object({}).strict().parse(body);
    const token = z
      .string()
      .min(1)
      .max(4096)
      .parse(firstRequestHeader(request.headers, 'x-pertexo-unsubscribe-key'));
    return this.preferences.unsubscribe(token);
  }
}
