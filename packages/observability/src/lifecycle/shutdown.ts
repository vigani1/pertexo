type ShutdownOwner = Readonly<{
  close: () => unknown;
  label: string;
}>;

/** Drain before releasing dependants, then their resources, exactly once. */
export class ShutdownCoordinator {
  private readonly owners: ShutdownOwner[] = [];
  private closePromise: Promise<void> | undefined;
  private failure: AggregateError | undefined;

  public constructor(
    private readonly options: Readonly<{ name: string; beginDrain(): void }>,
  ) {}

  public register(label: string, close: () => unknown): void {
    if (this.closePromise !== undefined)
      throw new Error(
        `${this.options.name} shutdown ownership is already closed`,
      );
    this.owners.push({ close, label });
  }

  public close(): Promise<void> {
    this.closePromise ??= this.performClose();
    return this.closePromise;
  }

  public throwIfFailed(): void {
    if (this.failure !== undefined) throw this.failure;
  }

  public async onApplicationShutdown(signal?: string): Promise<void> {
    await this.close();
    // Explicit close must finish Nest's listener cleanup before its public
    // wrapper surfaces resource failures. Signals have no such caller.
    if (signal !== undefined) this.throwIfFailed();
  }

  private async performClose(): Promise<void> {
    this.options.beginDrain();
    const failures: unknown[] = [];
    for (const owner of [...this.owners].reverse())
      await Promise.resolve()
        .then(owner.close)
        .catch((error: unknown) => failures.push(error));
    if (failures.length > 0)
      this.failure = new AggregateError(
        failures,
        `${this.options.name} resource shutdown failed`,
      );
  }
}
