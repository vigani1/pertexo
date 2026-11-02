import type { LiveRunEventNotification } from './stream.js';

/** Buffers one stream's hints; past capacity it asks for a resync rather than growing. */
export class BoundedNotificationQueue implements AsyncIterable<LiveRunEventNotification> {
  private closed = false;
  private readonly items: LiveRunEventNotification[] = [];
  private readonly waiters: ((
    result: IteratorResult<LiveRunEventNotification>,
  ) => void)[] = [];

  public constructor(private readonly capacity: number) {}

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
    this.items.length = 0;
  }

  public push(notification: LiveRunEventNotification): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value: notification });
      return;
    }

    if (this.items.length >= this.capacity) {
      // Coalesce overflow into one PostgreSQL resync. Dropping Redis hints is
      // safe because the durable event log remains authoritative.
      this.items.length = 0;
      this.items.push({ kind: 'resync' });
      return;
    }
    if (
      notification.kind === 'resync' &&
      this.items.some((item) => item.kind === 'resync')
    ) {
      return;
    }
    this.items.push(notification);
  }

  public [Symbol.asyncIterator](): AsyncIterator<LiveRunEventNotification> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) {
          return Promise.resolve({ done: false, value: item });
        }
        if (this.closed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}
