import {
  Catch,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
  UseInterceptors,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { OAUTH2_CALLBACK_PATH } from '@pertexo/contracts';

import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import { connectionFailure } from '../../problems/context/normalize.js';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../../workspaces/index.js';
import { projectAuthenticatedWorkspaceContext } from '../../workspaces/request/authenticated-context.js';
import { ConnectionManageGuard } from '../http/guards.js';
import { connectionIdParamSchema, type ConnectionRequest } from '../types.js';
import {
  FinishOAuth2AuthorizationUseCase,
  logOAuth2CallbackFailure,
} from './finish-authorization.js';
import { StartOAuth2AuthorizationUseCase } from './start-authorization.js';

type OAuth2Reply = Readonly<{
  header(name: string, value: string): unknown;
}>;

/**
 * A person arrives here in a popup, so even a rate limit or a database outage ends
 * on a landing page: a problem document would strand them and the tab that opened it.
 */
@Injectable()
@Catch()
class OAuth2CallbackFailureFilter implements ExceptionFilter {
  public constructor(
    private readonly finish: FinishOAuth2AuthorizationUseCase,
  ) {}

  public catch(exception: unknown, host: ArgumentsHost): void {
    logOAuth2CallbackFailure(exception);
    void host
      .switchToHttp()
      .getResponse<
        Readonly<{
          code(status: number): Readonly<{
            header(name: string, value: string): Readonly<{ send(): unknown }>;
          }>;
        }>
      >()
      .code(303)
      .header('location', this.finish.interrupted().location)
      .send();
  }
}

@UseInterceptors(domainErrors(connectionFailure))
@Controller()
export class ConnectionOAuth2Controller {
  public constructor(
    private readonly start: StartOAuth2AuthorizationUseCase,
    private readonly finish: FinishOAuth2AuthorizationUseCase,
  ) {}

  @Post(
    'v1/workspaces/:workspaceId/connections/:connectionId/oauth2/authorization',
  )
  @RateLimit('provider_test')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    ConnectionManageGuard,
    CsrfProtectionGuard,
  )
  public async startAuthorization(
    @Req() request: ConnectionRequest,
    @Param() params: unknown,
    @Res({ passthrough: true }) reply: OAuth2Reply,
  ) {
    const route = connectionIdParamSchema.parse(params);
    const started = await this.start.execute({
      ...projectAuthenticatedWorkspaceContext(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      connectionId: route.connectionId,
    });
    if (started.setCookie !== undefined)
      reply.header('set-cookie', started.setCookie);
    return started.response;
  }

  /** S11's headers are set for this path when a request arrives, so errors carry them too. */
  @Get(OAUTH2_CALLBACK_PATH.slice(1))
  @RateLimit('identity_callback')
  @UseFilters(OAuth2CallbackFailureFilter)
  @HttpCode(303)
  public async finishAuthorization(
    @Req() request: Readonly<{ headers: Readonly<Record<string, unknown>> }>,
    @Query() query: unknown,
    @Res({ passthrough: true }) reply: OAuth2Reply,
  ): Promise<void> {
    const { cookie } = request.headers;
    const finished = await this.finish.execute({
      query,
      cookieHeader: typeof cookie === 'string' ? cookie : undefined,
    });
    if (finished.clearCookie !== undefined)
      reply.header(
        'set-cookie',
        `${finished.clearCookie}=; Path=${OAUTH2_CALLBACK_PATH}; HttpOnly; SameSite=Lax; Max-Age=0`,
      );
    reply.header('location', finished.location);
  }
}
