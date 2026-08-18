import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { WorkspaceDatabase } from '@pertexo/database';

import { WORKSPACE_DATABASE } from '../database/database.module.js';

type ReadyResponse = Readonly<{
  status: 'ready';
}>;

const READY_RESPONSE: ReadyResponse = Object.freeze({ status: 'ready' });

@Controller('health')
export class ReadyController {
  public constructor(
    @Inject(WORKSPACE_DATABASE)
    private readonly database: WorkspaceDatabase,
  ) {}

  @Get('ready')
  public async ready(): Promise<ReadyResponse> {
    try {
      await this.database.checkReadiness();
      return READY_RESPONSE;
    } catch {
      throw new ServiceUnavailableException({ status: 'not_ready' });
    }
  }
}
