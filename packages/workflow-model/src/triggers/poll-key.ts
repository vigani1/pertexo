import { createHash } from 'node:crypto';
import { canonicalJson } from '../values/json/canonical.js';

export function hashPollItemKey(key: string | number): string {
  return createHash('sha256').update(canonicalJson(key)).digest('hex');
}
