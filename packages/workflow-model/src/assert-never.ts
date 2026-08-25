export function assertNever(value: never): never {
  throw new TypeError(`Unexpected domain variant: ${String(value)}`);
}
