import type { StructuredLogger } from '@pertexo/observability/logging';

interface CloseableWorkerApplication {
  close(signal?: string): Promise<void>;
}

type WorkerShutdownSignal = 'SIGINT' | 'SIGTERM';

export class WorkerProcessShutdown {
  private closePromise: Promise<void> | undefined;
  private installed = false;

  public constructor(
    private readonly application: CloseableWorkerApplication,
    private readonly logger: StructuredLogger,
  ) {}

  public install(): void {
    if (this.installed) return;
    let sigintRegistered = false;
    try {
      process.once('SIGINT', this.onSigint);
      sigintRegistered = true;
      process.once('SIGTERM', this.onSigterm);
      this.installed = true;
    } catch (error: unknown) {
      if (sigintRegistered) {
        process.removeListener('SIGINT', this.onSigint);
      }
      throw error;
    }
  }

  public close(signal?: WorkerShutdownSignal): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;

    let resolveClose!: () => void;
    this.closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    let applicationClose: Promise<void>;
    try {
      applicationClose = this.application.close(signal);
    } catch (error: unknown) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- preserve a hostile application boundary exactly
      applicationClose = Promise.reject(error);
    }
    void applicationClose.then(
      () => {
        this.uninstall();
        resolveClose();
      },
      (error: unknown) => {
        process.exitCode = 1;
        try {
          this.logger.error(
            'worker.shutdown_failed',
            signal === undefined ? {} : { signal },
            error,
          );
        } catch {
          // A diagnostic destination must not prevent owned listener cleanup.
        }
        this.uninstall();
        resolveClose();
      },
    );
    return this.closePromise;
  }

  private readonly onSigint = (): void => {
    void this.close('SIGINT').catch(() => undefined);
  };

  private readonly onSigterm = (): void => {
    void this.close('SIGTERM').catch(() => undefined);
  };

  private uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    process.removeListener('SIGINT', this.onSigint);
    process.removeListener('SIGTERM', this.onSigterm);
  }
}
