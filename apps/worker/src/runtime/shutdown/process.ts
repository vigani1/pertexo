import type { StructuredLogger } from '@pertexo/observability';

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
    process.once('SIGINT', this.onSigint);
    process.once('SIGTERM', this.onSigterm);
    this.installed = true;
  }

  /** Closes once; a failure is logged and sets a failing exit code. */
  public close(signal?: WorkerShutdownSignal): Promise<void> {
    this.closePromise ??= (async () => {
      try {
        await this.application.close(signal);
      } catch (error: unknown) {
        process.exitCode = 1;
        this.logger.error(
          'worker.shutdown_failed',
          signal === undefined ? {} : { signal },
          error,
        );
      } finally {
        this.uninstall();
      }
    })();
    return this.closePromise;
  }

  private readonly onSigint = (): void => {
    void this.close('SIGINT');
  };

  private readonly onSigterm = (): void => {
    void this.close('SIGTERM');
  };

  private uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    process.removeListener('SIGINT', this.onSigint);
    process.removeListener('SIGTERM', this.onSigterm);
  }
}
