export const WORKFLOW_PORTABILITY_LIMITS = Object.freeze({
  bytes: 2_097_152,
  inputDepth: 256,
  requirements: 1_000,
  connectionSlots: 1_000,
  issues: 100,
});

/** Admission and field bounds inside a portable manifest. */
export const PORTABLE_MANIFEST_FIELD_LIMITS = Object.freeze({
  jsonValueDepth: 64,
  structuredDepth: 32,
  identifierLength: 1_048_576,
  keyLength: 128,
  issuePathLength: 2_048,
  issueMessageLength: 512,
});
