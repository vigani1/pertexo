import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Query,
  Redirect,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import { noticeOneClickQuerySchema } from '@pertexo/contracts';
import type { FastifyRequest } from 'fastify';
import { firstRequestHeader } from '../../platform/http/request-headers.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import { NoticePreferencesService } from './service.js';
@Controller('v1/notifications/unsubscribe')
@RateLimit('notice_unsubscribe')
export class NoticeUnsubscribeController {
  constructor(private readonly preferences: NoticePreferencesService) {}
  @Post('one-click')
  @HttpCode(200)
  oneClick(@Query() query: unknown) {
    const { token } = noticeOneClickQuerySchema.parse(query);
    return this.preferences.unsubscribe(token);
  }
  @Get('one-click')
  @Redirect(undefined, 303)
  confirm(@Query() query: unknown) {
    const { token } = noticeOneClickQuerySchema.parse(query);
    return { url: `/notifications/unsubscribe#${encodeURIComponent(token)}` };
  }
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
