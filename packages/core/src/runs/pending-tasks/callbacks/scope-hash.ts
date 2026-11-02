import { createHash } from 'node:crypto';
import { canonicalJson } from '@pertexo/workflow-model';
export function callbackScopeHash(scope: unknown): string {
  return createHash('sha256').update(canonicalJson(scope)).digest('hex');
}
