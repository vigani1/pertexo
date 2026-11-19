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

/** An error described without its message, cause or properties. */
export type CleanupErrorShape = Readonly<{
  errorClass: string;
  code: string | undefined;
  /** The shapes of an AggregateError's errors, since owners nest them. */
  errors: readonly CleanupErrorShape[];
}>;

/** One failed resource, by its fixed name and its error's shape. */
export type FixtureCleanupFailure = Readonly<{
  resource: string;
  error: CleanupErrorShape;
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
// Runtimes nest aggregates a level or two deep; the bound only stops cycles.
const NESTED_AGGREGATE_DEPTH = 3;

export function describeCleanupFailure(
  resource: string,
  error: unknown,
): FixtureCleanupFailure {
  return { resource, error: errorShape(error, NESTED_AGGREGATE_DEPTH) };
}

function errorShape(error: unknown, depth: number): CleanupErrorShape {
  if (!(error instanceof Error))
    return {
      errorClass: `non-error ${typeof error}`,
      code: undefined,
      errors: [],
    };
  const errorClass: unknown = error.constructor.name;
  const code: unknown = Object.getOwnPropertyDescriptor(error, 'code')?.value;
  const nested: unknown =
    error instanceof AggregateError && depth > 0 ? error.errors : [];
  return {
    errorClass:
      typeof errorClass === 'string' && ERROR_CLASS.test(errorClass)
        ? errorClass
        : 'unnamed error',
    code: typeof code === 'string' && ERROR_CODE.test(code) ? code : undefined,
    errors: Array.isArray(nested)
      ? nested.map((inner: unknown) => errorShape(inner, depth - 1))
      : [],
  };
}

export function formatCleanupFailure(failure: FixtureCleanupFailure): string {
  return `${failure.resource} (${formatErrorShape(failure.error)})`;
}

function formatErrorShape(shape: CleanupErrorShape): string {
  const code = shape.code === undefined ? '' : ` ${shape.code}`;
  const nested =
    shape.errors.length === 0
      ? ''
      : ` [${shape.errors.map(formatErrorShape).join('; ')}]`;
  return `${shape.errorClass}${code}${nested}`;
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
