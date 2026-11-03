import {
  Catch,
  Controller,
  Get,
  Inject,
  Optional,
  ServiceUnavailableException,
  UseFilters,
} from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { WorkspaceDatabase } from '@pertexo/database/platform';
import type { StructuredLogger } from '@pertexo/observability';

import { WORKSPACE_DATABASE } from '../database/database.module.js';
import { RateLimitExempt } from '../rate-limit/metadata.js';
import { ApiDrainState } from './drain-state.js';

type ReadyResponse = Readonly<{
  status: 'ready';
}>;

const READY_RESPONSE: ReadyResponse = Object.freeze({ status: 'ready' });
export const API_RUNTIME_READINESS = Symbol('API_RUNTIME_READINESS');
export const API_READINESS_LOGGER = Symbol('API_READINESS_LOGGER');
export interface ApiRuntimeReadiness {
  checkReadiness(): Promise<void>;
}

/** A probe reads this route's own answer. A not-ready API isn't a problem with a request. */
@Catch(ServiceUnavailableException)
class NotReadyFilter implements ExceptionFilter<ServiceUnavailableException> {
  public catch(
    exception: ServiceUnavailableException,
    host: ArgumentsHost,
  ): void {
    void host
      .switchToHttp()
      .getResponse<FastifyReply>()
      .status(exception.getStatus())
      .send(exception.getResponse());
  }
}

@Controller('health')
@RateLimitExempt()
@UseFilters(NotReadyFilter)
export class ReadyController {
  public constructor(
    @Inject(WORKSPACE_DATABASE)
    private readonly database: WorkspaceDatabase,
    private readonly drainState: ApiDrainState,
    @Optional()
    @Inject(API_RUNTIME_READINESS)
    private readonly runtimeReadiness?: ApiRuntimeReadiness,
    @Optional()
    @Inject(API_READINESS_LOGGER)
    private readonly logger?: Pick<StructuredLogger, 'warn'>,
  ) {}

  @Get('ready')
  public async ready(): Promise<ReadyResponse> {
    if (this.drainState.isDraining()) {
      throw new ServiceUnavailableException({ status: 'not_ready' });
    }

    try {
      await Promise.all([
        this.database.checkReadiness(),
        this.runtimeReadiness?.checkReadiness(),
      ]);
    } catch (error: unknown) {
      // A probe gets no detail; the operator needs to know which check failed.
      this.logger?.warn('health.not_ready', {}, error);
      throw new ServiceUnavailableException({ status: 'not_ready' });
    }
    if (this.drainState.isDraining())
      throw new ServiceUnavailableException({ status: 'not_ready' });
    return READY_RESPONSE;
  }
}
