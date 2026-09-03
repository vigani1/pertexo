# Immutability and optional-property policy

Runtime immutability is applied at ownership boundaries, not as a mechanical
property of every temporary object.

- Untrusted input is validated and normalized before it becomes a domain value.
  Exported configuration, catalogs, authorization capabilities, checksummed
  envelopes, and cached/shared domain values remain frozen after that boundary.
- Persistence adapters return values that callers may safely retain. Durable
  JSON and checkpoint values are cloned or frozen where caller mutation could
  change later serialization, checksums, retries, or audit evidence.
- Short-lived private construction objects do not require `Object.freeze`
  merely for style. Removing an existing freeze requires a mutation regression
  proving that callers neither depend on rejected writes nor observe aliasing.
- An optional property is omitted when absence is part of the wire, checksum,
  patch, or persistence contract. Owner interfaces may accept explicit
  `undefined` only when it is semantically identical to absence and does not
  weaken `exactOptionalPropertyTypes` at a public boundary.
- Do not introduce a generic optional-spread or deep-freeze helper. Keep the
  transition visible at the owner that knows whether absence and immutability
  are significant.

Performance-motivated changes to large graphs or repeated response values need
allocation or latency evidence before and after the change. Configuration,
catalog, capability, and checksum boundaries must not be weakened to improve a
microbenchmark.
