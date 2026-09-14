type Constructor<T> = abstract new (...arguments_: never[]) => T;

export function safeInstanceOf<T>(
  value: unknown,
  constructor: Constructor<T>,
): value is T {
  try {
    return value instanceof constructor;
  } catch {
    return false;
  }
}

export function errorNameIs(value: unknown, expected: string): boolean {
  try {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as { readonly name?: unknown }).name === expected
    );
  } catch {
    return false;
  }
}

export function errorCodeIs(value: unknown, expected: string): boolean {
  try {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as { readonly code?: unknown }).code === expected
    );
  } catch {
    return false;
  }
}

export function safeNumberProperty(
  value: unknown,
  property: string,
): number | undefined {
  try {
    if (typeof value !== 'object' || value === null) return undefined;
    const candidate = (value as Record<string, unknown>)[property];
    return typeof candidate === 'number' && Number.isFinite(candidate)
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeUnknownError(value: unknown, message: string): Error {
  return safeInstanceOf(value, Error) ? value : new Error(message);
}
