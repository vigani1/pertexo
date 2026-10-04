import type { Pool, PoolClient } from 'pg';

import { destroyCanceledPoolClient } from '../platform/pool-client-disposal.js';
import { acquireAbortablePoolClient } from '../platform/abortable-pool-checkout.js';

/** Native read ownership stays inside the existing tenant transaction module. */
export class NativeTenantRead {
  private readonly abort = new AbortController();
  public readonly signal = this.abort.signal;
  private readonly operationTimer: ReturnType<typeof setTimeout>;
  private cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  private exhausted: Error | undefined;
  private cleanupDeadline: number | undefined;
  private checkout: Promise<PoolClient> | undefined;
  private disposal: Promise<void> | undefined;
  private termination: Promise<void> | undefined;
  private deliveredClient: PoolClient | undefined;
  private onClientEnd: (() => void) | undefined;
  private readonly cleanupMillis: number;
  private readonly operationDeadline: number;
  private readonly stop = (): void => {
    if (this.signal.aborted) return;
    this.beginCleanup();
    this.abort.abort(this.abortError);
  };

  private beginCleanup(): void {
    if (this.cleanupDeadline !== undefined) return;
    this.cleanupDeadline = performance.now() + this.cleanupMillis;
    this.cleanupTimer = setTimeout(() => {
      this.exhausted = new Error(
        'Native read joined-cleanup deadline exceeded',
      );
    }, this.cleanupMillis);
  }

  public constructor(
    private readonly pool: Pool,
    private readonly contextSignal: AbortSignal | undefined,
    budget: Readonly<{
      readTimeoutMillis: number;
      controlReadTimeoutMillis: number;
    }>,
    private readonly abortError: Error,
  ) {
    const { readTimeoutMillis, controlReadTimeoutMillis } = budget;
    const acquisitionTimeoutMillis = pool.options.connectionTimeoutMillis;
    if (
      !Number.isFinite(readTimeoutMillis) ||
      readTimeoutMillis <= 0 ||
      !Number.isSafeInteger(controlReadTimeoutMillis) ||
      controlReadTimeoutMillis < 100 ||
      controlReadTimeoutMillis > 5_000 ||
      readTimeoutMillis > controlReadTimeoutMillis
    )
      throw new RangeError('Invalid native read budget');
    if (
      acquisitionTimeoutMillis === undefined ||
      !Number.isSafeInteger(acquisitionTimeoutMillis) ||
      acquisitionTimeoutMillis <= 0 ||
      acquisitionTimeoutMillis > readTimeoutMillis
    )
      throw new RangeError(
        'Pool acquisition bound exceeds native read operation budget',
      );
    this.cleanupMillis = 2 * controlReadTimeoutMillis + 2_000;
    this.operationDeadline = performance.now() + readTimeoutMillis;
    this.operationTimer = setTimeout(this.stop, readTimeoutMillis);
    contextSignal?.addEventListener('abort', this.stop, { once: true });
    if (contextSignal?.aborted) this.stop();
  }

  public remainingMillis(): number {
    const remaining = Math.floor(this.operationDeadline - performance.now());
    if (remaining < 1) this.stop();
    if (this.signal.aborted) throw this.abortError;
    return remaining;
  }

  public isStopped(): boolean {
    if (performance.now() >= this.operationDeadline) this.stop();
    return this.signal.aborted;
  }

  public async acquire(): Promise<PoolClient> {
    this.checkout = new Promise<PoolClient>((resolve, reject) => {
      this.pool.connect((error, client) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        if (client === undefined) {
          reject(new Error('Native pool checkout omitted client'));
          return;
        }
        // Observe terminal ownership in the driver's delivery callback, before
        // a next-tick terminal event can outrun promise continuation delivery.
        this.deliveredClient = client;
        this.termination = new Promise<void>((terminate) => {
          this.onClientEnd = terminate;
          client.once('end', terminate);
        });
        resolve(client);
      });
    });
    const checkout = this.checkout;
    if (this.signal.aborted) {
      await checkout.then(
        (client) => {
          this.dispose(client);
        },
        () => undefined,
      );
      throw this.abortError;
    }
    return acquireAbortablePoolClient(
      { connect: () => checkout },
      this.signal,
      () => this.abortError,
      (client) => {
        this.dispose(client);
      },
    );
  }

  public dispose(client: PoolClient): void {
    this.beginCleanup();
    this.disposal = destroyCanceledPoolClient(client, this.abortError, {
      join: true,
      ...(this.termination === undefined
        ? {}
        : { termination: this.termination }),
    });
    // Observe now, but retain the actual promise and failure for finish().
    void this.disposal.catch(() => undefined);
  }

  public async finish(failure?: Readonly<{ error: unknown }>): Promise<void> {
    const cleanupErrors: unknown[] = [];
    try {
      // A construction not delivered to this caller remains shared-pool-owned.
      await this.checkout?.catch(() => undefined);
      try {
        await this.disposal;
      } catch (error: unknown) {
        cleanupErrors.push(error);
      }
      if (
        this.cleanupDeadline !== undefined &&
        performance.now() >= this.cleanupDeadline
      )
        this.exhausted ??= new Error(
          'Native read joined-cleanup deadline exceeded',
        );
      if (this.exhausted !== undefined) cleanupErrors.push(this.exhausted);
      if (cleanupErrors.length > 0)
        throw new AggregateError(
          [...(failure === undefined ? [] : [failure.error]), ...cleanupErrors],
          'Native read ownership cleanup failed',
        );
    } finally {
      if (this.onClientEnd !== undefined)
        this.deliveredClient?.removeListener('end', this.onClientEnd);
      clearTimeout(this.operationTimer);
      clearTimeout(this.cleanupTimer);
      this.contextSignal?.removeEventListener('abort', this.stop);
    }
  }
}
