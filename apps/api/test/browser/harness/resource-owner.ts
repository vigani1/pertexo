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
    if (failures.length > 0) throw new FixtureCleanupError(failures);
  }
}

/** One failed resource, described without the error's message, cause or properties. */
export type FixtureCleanupFailure = Readonly<{
  resource: string;
  errorClass: string;
  code: string | undefined;
}>;

/**
 * The owner's aggregate: the original errors stay in `errors` for callers that
 * may hold them, and `failures` is the part safe to print or serialize.
 */
export class FixtureCleanupError extends AggregateError {
  public readonly failures: readonly FixtureCleanupFailure[];

  public constructor(
    failures: readonly Readonly<{ name: string; error: unknown }>[],
  ) {
    const described = failures.map((failure) =>
      describeCleanupFailure(failure.name, failure.error),
    );
    super(
      failures.map((failure) => failure.error),
      `Fixture resource cleanup failed: ${described.map(formatCleanupFailure).join(', ')}`,
    );
    this.name = 'FixtureCleanupError';
    this.failures = described;
  }
}

// Class names and codes are identifiers (ECONNRESET, 57P01, ERR_STREAM_DESTROYED);
// anything else could be data, so it is not reported.
const ERROR_CLASS = /^[A-Za-z_$][\w$]{0,63}$/u;
const ERROR_CODE = /^[A-Z0-9_]{1,64}$/u;

export function describeCleanupFailure(
  resource: string,
  error: unknown,
): FixtureCleanupFailure {
  if (!(error instanceof Error))
    return {
      resource,
      errorClass: `non-error ${typeof error}`,
      code: undefined,
    };
  const errorClass: unknown = error.constructor.name;
  const code: unknown = Object.getOwnPropertyDescriptor(error, 'code')?.value;
  return {
    resource,
    errorClass:
      typeof errorClass === 'string' && ERROR_CLASS.test(errorClass)
        ? errorClass
        : 'unnamed error',
    code: typeof code === 'string' && ERROR_CODE.test(code) ? code : undefined,
  };
}

export function formatCleanupFailure(failure: FixtureCleanupFailure): string {
  return `${failure.resource} (${failure.errorClass}${failure.code === undefined ? '' : ` ${failure.code}`})`;
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
