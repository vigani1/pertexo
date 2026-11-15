import {
  canonicalJson,
  BoundedJsonInvalidError,
} from '@pertexo/database/primitives';

const OPERATOR_JSON_LIMITS = Object.freeze({ depth: 64, members: 10_000 });

/** Immutable, descriptor-safe operator input serialization with explicit bounds. */
export function serializeBoundedPlainJson(
  payload: unknown,
  maximumBytes: number,
  label: string,
): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new TypeError(`${label} byte limit is invalid`);
  try {
    return canonicalJson(payload, maximumBytes, {
      maximumDatabaseBytes: undefined,
      label,
      constraints: {
        maximumDepth: OPERATOR_JSON_LIMITS.depth,
        maximumMembers: OPERATOR_JSON_LIMITS.members,
        plainObjectsOnly: true,
        rejectSymbols: true,
      },
    });
  } catch (error: unknown) {
    let boundedFailure = false;
    try {
      boundedFailure = error instanceof BoundedJsonInvalidError;
    } catch {
      // A hostile thrown value is normalized below without further inspection.
    }
    if (boundedFailure) throw error;
    throw new BoundedJsonInvalidError(`${label} could not be inspected safely`);
  }
}
