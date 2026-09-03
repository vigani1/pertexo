import type {
  LeasedOutboxEvent,
  OutboxDispatcherDatabase,
} from '@pertexo/database/execution';

import { bounded } from './transport-operation-deadline.js';

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
    const pending = settlement
      .then(async (outcome) => {
        if (outcome !== 'published') return;
        await bounded(
          this.database.markPublished(event.id, event.leaseToken),
          this.operationTimeoutMillis,
        );
      })
      .catch(() => undefined)
      .finally(() => {
        this.pending.delete(pending);
      });
    this.pending.add(pending);
  }

  public boundedPending(): readonly Promise<void>[] {
    return [...this.pending].map((settlement) =>
      bounded(settlement, this.operationTimeoutMillis),
    );
  }
}
