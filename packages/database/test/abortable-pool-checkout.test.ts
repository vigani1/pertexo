import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { acquireAbortablePoolClient } from '../src/platform/pool/abortable-checkout.js';

describe('abortable pool checkout', () => {
  it('does not start checkout when already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('pre-aborted');
    controller.abort(reason);
    const connect = vi.fn();
    await expect(
      acquireAbortablePoolClient(
        { connect },
        controller.signal,
        () => reason,
        vi.fn(),
      ),
    ).rejects.toBe(reason);
    expect(connect).not.toHaveBeenCalled();
  });

  it('releases a late checkout exactly once and absorbs late rejection', async () => {
    const controller = new AbortController();
    const checkout = Promise.withResolvers<PoolClient>();
    const release = vi.fn();
    const reason = new Error('queued abort');
    const acquiring = acquireAbortablePoolClient(
      { connect: () => checkout.promise },
      controller.signal,
      () => reason,
      (client) => {
        client.release();
      },
    );
    controller.abort(reason);
    await expect(acquiring).rejects.toBe(reason);
    checkout.resolve({ release } as unknown as PoolClient);
    await Promise.resolve();
    expect(release).toHaveBeenCalledOnce();

    const rejectedCheckout = Promise.withResolvers<PoolClient>();
    const rejectedController = new AbortController();
    const later = acquireAbortablePoolClient(
      { connect: () => rejectedCheckout.promise },
      rejectedController.signal,
      () => reason,
      vi.fn(),
    );
    const hostile = { reason: 'transport failure' };
    rejectedController.abort(reason);
    await expect(later).rejects.toBe(reason);
    rejectedCheckout.reject(hostile);
    await Promise.resolve();
  });

  it('keeps a granted client with its caller when grant wins the race', async () => {
    const controller = new AbortController();
    const releaseLate = vi.fn();
    const release = vi.fn();
    const client = { release } as unknown as PoolClient;
    await expect(
      acquireAbortablePoolClient(
        { connect: () => Promise.resolve(client) },
        controller.signal,
        () => new Error('aborted'),
        releaseLate,
      ),
    ).resolves.toBe(client);
    controller.abort();
    expect(releaseLate).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('does not leak a rejected late checkout or thrown late disposal', async () => {
    const controller = new AbortController();
    const checkout = Promise.withResolvers<PoolClient>();
    const acquiring = acquireAbortablePoolClient(
      { connect: () => checkout.promise },
      controller.signal,
      () => new Error('canceled'),
      () => {
        throw new Error('late release failed');
      },
    );
    controller.abort();
    await expect(acquiring).rejects.toThrow('canceled');
    checkout.resolve({ release: vi.fn() } as unknown as PoolClient);
    await Promise.resolve();

    const hostile = { failure: 'checkout rejected' };
    const failedCheckout = Promise.withResolvers<PoolClient>();
    const failure = acquireAbortablePoolClient(
      { connect: () => failedCheckout.promise },
      new AbortController().signal,
      () => new Error('canceled'),
      vi.fn(),
    );
    failedCheckout.reject(hostile);
    await expect(failure).rejects.toMatchObject({ cause: hostile });
  });

  it('releases once when abort wins a grant queued in the same turn', async () => {
    const controller = new AbortController();
    const checkout = Promise.withResolvers<PoolClient>();
    const release = vi.fn();
    const client = { release } as unknown as PoolClient;
    const acquiring = acquireAbortablePoolClient(
      { connect: () => checkout.promise },
      controller.signal,
      () => new Error('aborted before grant callback'),
      (lateClient) => {
        lateClient.release();
        throw new Error('late-disposal diagnostic failed');
      },
    );
    checkout.resolve(client);
    controller.abort();
    await expect(acquiring).rejects.toThrow('aborted before grant callback');
    await Promise.resolve();
    expect(release).toHaveBeenCalledOnce();
  });

  it('normalizes a rejection whose instanceof inspection is hostile', async () => {
    const rejected = Promise.withResolvers<PoolClient>();
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('hostile prototype');
        },
      },
    );
    const acquiring = acquireAbortablePoolClient(
      { connect: () => rejected.promise },
      new AbortController().signal,
      () => new Error('aborted'),
      vi.fn(),
    );
    rejected.reject(hostile);
    const error = await acquiring.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('Expected checkout error');
    expect(Reflect.get(error, 'cause')).toBe(hostile);
  });
});
