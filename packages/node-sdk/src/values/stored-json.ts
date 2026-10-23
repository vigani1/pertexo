export const STORED_EXECUTION_VALUE_LIMITS = Object.freeze({
  inlineBytes: 262_144,
  depth: 64,
  members: 10_000,
});

export class StoredExecutionValueInvalidError extends TypeError {
  public override readonly name = 'StoredExecutionValueInvalidError';

  public constructor() {
    super('Stored execution value violates the persistence contract');
  }
}

function invalid(): never {
  throw new StoredExecutionValueInvalidError();
}

export function storedExecutionJsonStringBytes(value: string): number {
  // JSON needs at least its quotes plus one byte per UTF-16 code unit.
  // Bound the native Unicode check and keep the SDK graph-independent.
  if (
    value.length > STORED_EXECUTION_VALUE_LIMITS.inlineBytes - 2 ||
    !value.isWellFormed()
  )
    invalid();
  let bytes = 2;
  const add = (amount: number): void => {
    bytes += amount;
    if (bytes > STORED_EXECUTION_VALUE_LIMITS.inlineBytes) invalid();
  };
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) invalid();
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x0c ||
      code === 0x0a ||
      code === 0x0d ||
      code === 0x09
    )
      add(2);
    else if (code <= 0x1f) add(6);
    else if (code <= 0x7f) add(1);
    else if (code <= 0x7ff) add(2);
    else if (code >= 0xd800 && code <= 0xdbff) {
      add(4);
      index += 1;
    } else add(3);
  }
  return bytes;
}
