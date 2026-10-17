import { Logger } from '@nestjs/common';
import type { RedisRateLimitRuntime } from '@pertexo/rate-limit';
import {
  applicationError,
  throwApplicationError,
} from '../application-error.js';
import { EXPORT_INSTANCE_LIMIT, EXPORT_SLOT_MILLIS } from './limits.js';

export class CsvExportAdmission {
  private active = 0;
  private readonly logger = new Logger(CsvExportAdmission.name);
  constructor(
    private readonly slots: Pick<RedisRateLimitRuntime, 'acquireExclusiveSlot'>,
  ) {}

  async run<T>(workspaceId: string, work: () => Promise<T>): Promise<T> {
    if (this.active >= EXPORT_INSTANCE_LIMIT) this.refuse();
    this.active += 1;
    let slot: Awaited<
      ReturnType<RedisRateLimitRuntime['acquireExclusiveSlot']>
    > = null;
    try {
      try {
        // Keep the namespace shared with table exports during rolling upgrades.
        slot = await this.slots.acquireExclusiveSlot(
          `data-table-export:${workspaceId}`,
          EXPORT_SLOT_MILLIS,
        );
      } catch (cause) {
        throwApplicationError(
          applicationError('request.rate_limit_unavailable', {
            cause,
            details: { retryAfterSeconds: 1 },
          }),
        );
      }
      if (slot === null) this.refuse();
      return await work();
    } finally {
      try {
        await slot?.release();
      } catch {
        // The response may already have completed or disconnected, including
        // during shutdown. Never replace its outcome with a cleanup error.
        this.logger.warn(
          'Could not release CSV export slot; it will expire automatically.',
        );
      } finally {
        this.active -= 1;
      }
    }
  }

  private refuse(): never {
    throwApplicationError(
      applicationError('workspace.conflict', {
        safeDetail:
          'An export is already running. Wait for it to finish or cancel it, then try again.',
      }),
    );
  }
}
