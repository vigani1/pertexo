import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { createIdentityWorkspaceSessionStore } from '../src/tenant-access/identity-workspace-session-store.js';

describe('identity session lookup cancellation', () => {
  it('passes the caller signal to a stalled PostgreSQL query', async () => {
    const controller = new AbortController();
    const query = vi.fn(
      (config: Readonly<{ signal?: AbortSignal }>): Promise<never> =>
        new Promise((_resolve, reject) => {
          config.signal?.addEventListener(
            'abort',
            () => {
              reject(config.signal?.reason as Error);
            },
            { once: true },
          );
        }),
    );
    const store = createIdentityWorkspaceSessionStore({
      query,
    } as never as Pool);
    const lookup = store.findActiveSessionByDigest('a'.repeat(64), {
      signal: controller.signal,
    });
    const reason = new DOMException('stream closed', 'AbortError');

    expect(query.mock.calls[0]?.[0].signal).toBe(controller.signal);
    controller.abort(reason);

    await expect(lookup).rejects.toBe(reason);
  });
});
