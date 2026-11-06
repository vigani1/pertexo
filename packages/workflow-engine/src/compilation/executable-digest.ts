import { createHash } from 'node:crypto';
import { canonicalJson } from '@pertexo/workflow-model';
export function digest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(canonicalJson({ domain, value }))
    .digest('hex');
}
