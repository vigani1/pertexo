type OwnedResource = Readonly<{
  name: string;
  value: object;
  close: () => void | Promise<void>;
}>;

export class FixtureResourceOwner {
  private readonly resources: OwnedResource[] = [];
  private readonly transferred = new WeakSet<object>();
  private closePromise: Promise<void> | undefined;

  public acquire<T extends object>(
    name: string,
    value: T,
    close: (value: T) => void | Promise<void>,
  ): T {
    if (this.closePromise !== undefined)
      throw new Error('Cannot acquire a resource after fixture cleanup starts');
    this.resources.push({
      name,
      value,
      close: () => close(value),
    });
    return value;
  }

  public transfer(value: object): void {
    const acquired = this.resources.some(
      (resource) => resource.value === value,
    );
    if (!acquired)
      throw new Error('Cannot transfer an unowned fixture resource');
    this.transferred.add(value);
  }

  public close(): Promise<void> {
    this.closePromise ??= this.closeResources();
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    const failures: Readonly<{ name: string; error: unknown }>[] = [];
    for (const resource of this.resources.toReversed()) {
      if (this.transferred.has(resource.value)) continue;
      try {
        await Promise.resolve().then(() => resource.close());
      } catch (error: unknown) {
        failures.push({ name: resource.name, error });
      }
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures.map((failure) => failure.error),
        `Fixture resource cleanup failed: ${failures.map((failure) => failure.name).join(', ')}`,
      );
  }
}

export async function rethrowFixtureSetupFailure(
  owner: FixtureResourceOwner,
  original: unknown,
): Promise<never> {
  try {
    await owner.close();
  } catch (cleanupError: unknown) {
    const cleanupFailures =
      cleanupError instanceof AggregateError
        ? Array.from(cleanupError.errors as Iterable<unknown>)
        : [cleanupError];
    throw new AggregateError(
      [original, ...cleanupFailures],
      'Fixture setup and cleanup failed',
    );
  }
  throw original;
}
