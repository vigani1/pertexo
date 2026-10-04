import { createHash } from 'node:crypto';
import { canonicalizeJson, canonicalJson } from './canonical-json.js';

/** Pure declaration semantics. Callers own representation bounds and scheduling. */
export function inspectForEachCollection(value: unknown): Readonly<{
  collectionSize: number;
  collectionChecksum: string;
}> {
  const output = canonicalizeJson(value);
  if (
    output === null ||
    typeof output !== 'object' ||
    Array.isArray(output) ||
    Object.keys(output).sort().join(',') !== 'items,iterationCount'
  )
    throw new TypeError('For Each output is invalid');
  const items = Reflect.get(output, 'items') as unknown;
  const count = Reflect.get(output, 'iterationCount') as unknown;
  if (
    !Array.isArray(items) ||
    !Number.isSafeInteger(count) ||
    count !== items.length
  )
    throw new TypeError('For Each output is invalid');
  return Object.freeze({
    collectionSize: items.length,
    collectionChecksum: createHash('sha256')
      .update(canonicalJson(items))
      .digest('hex'),
  });
}
