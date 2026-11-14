import { inspectJsonValue } from '../../values/json/canonical.js';

// PostgreSQL jsonb text puts a space after every separator, so each member costs this much more.
const JSONB_SEPARATOR_BYTES = 2;
export const PENDING_TASK_LIMITS = Object.freeze({
  titleCharacters: 160,
  configBytes: 16_384,
  detailNameCharacters: 160,
  detailFields: 20,
  detailListItems: 20,
  detailsBytes: 8_192,
  contextBytes: 73_728,
  decidedByNameCharacters: 256,
  instructionsCharacters: 2_000,
  commentCharacters: 2_000,
  audienceMembers: 50,
  defaultExpirySeconds: 604_800,
  minimumExpirySeconds: 3_600,
  maximumExpirySeconds: 2_592_000,
});
/** The bytes a task value takes in its jsonb column, which every task size limit bounds. */
export function storedTaskBytes(value: unknown): number {
  const { bytes, members } = inspectJsonValue(value);
  return bytes + JSONB_SEPARATOR_BYTES * members;
}
