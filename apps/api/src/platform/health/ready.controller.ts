import {
  Controller,
  Get,
  Inject,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { WorkspaceDatabase } from '@pertexo/database/api';

import { WORKSPACE_DATABASE } from '../database/database.module.js';
import { ApiDrainState } from './drain-state.js';

type ReadyResponse = Readonly<{
  status: 'ready';
}>;

const READY_RESPONSE: ReadyResponse = Object.freeze({ status: 'ready' });
export const API_RUNTIME_READINESS = Symbol('API_RUNTIME_READINESS');
export interface ApiRuntimeReadiness {
  checkReadiness(): Promise<void>;
}

@Controller('health')
export class ReadyController {
  public constructor(
    @Inject(WORKSPACE_DATABASE)
    private readonly database: WorkspaceDatabase,
    private readonly drainState: ApiDrainState,
    @Optional()
    @Inject(API_RUNTIME_READINESS)
    private readonly runtimeReadiness?: ApiRuntimeReadiness,
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
      return READY_RESPONSE;
    } catch {
      throw new ServiceUnavailableException({ status: 'not_ready' });
    }
  }
}
