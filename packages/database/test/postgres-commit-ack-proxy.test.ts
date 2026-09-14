import { describe, expect, it } from 'vitest';

import { createPostgresCommitAckProxy } from './support/postgres-commit-ack-proxy.js';

describe('PostgreSQL COMMIT acknowledgement proxy lifecycle', () => {
  it('settles an armed milestone on idempotent close without leaving sockets', async () => {
    const proxy = await createPostgresCommitAckProxy(
      'postgresql://unused:unused@127.0.0.1:1/unused',
    );
    const milestone = proxy.dropNextCommitAcknowledgement();
    expect(() => proxy.dropNextCommitAcknowledgement()).toThrow(
      'PostgreSQL acknowledgement drop is already armed',
    );
    const observedMilestone = expect(milestone).rejects.toThrow(
      'PostgreSQL acknowledgement proxy closed before COMMIT',
    );

    await Promise.all([proxy.close(), proxy.close()]);
    await observedMilestone;
    expect(proxy.activeSocketCount()).toBe(0);
    expect(proxy.connectionCount()).toBe(0);
  });
});
