import type {
  LeasedOutboxEvent,
  OutboxDispatcherDatabase,
} from '@pertexo/database/execution';

import {
  bounded,
  TransportOperationTimeoutError,
} from './transport-operation-deadline.js';

export class OutboxPublicationSettlements {
  private readonly pending = new Set<Promise<void>>();

  public constructor(
    private readonly database: OutboxDispatcherDatabase,
    private readonly operationTimeoutMillis: number,
  ) {}

  public track(
    event: LeasedOutboxEvent,
    settlement: Promise<'failed' | 'published'>,
  ): void {
    this.own(
      settlement.then(async (outcome) => {
        if (outcome !== 'published') return;
        await this.database.markPublished(event.id, event.leaseToken);
      }),
    );
  }

  public async markPublished(
    event: LeasedOutboxEvent,
  ): Promise<boolean | 'outcome_unknown'> {
    const settlement = this.database.markPublished(event.id, event.leaseToken);
    try {
      return await bounded(settlement, this.operationTimeoutMillis);
    } catch (error: unknown) {
      if (!isTransportTimeout(error)) throw error;
      // The client cannot prove cancellation. Keep ownership until the late
      // write settles and never release a lease that it may still consume.
      this.own(settlement);
      return 'outcome_unknown';
    }
  }

  private own(settlement: Promise<unknown>): void {
    const pending = settlement
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.pending.delete(pending);
      });
    this.pending.add(pending);
  }

  public pendingSettlements(): readonly Promise<void>[] {
    return [...this.pending];
  }
}

function isTransportTimeout(error: unknown): boolean {
  try {
    return error instanceof TransportOperationTimeoutError;
  } catch {
    return false;
  }
}
