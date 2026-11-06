import { canonicalJson } from '@pertexo/workflow-model';
import { createHash, randomUUID } from 'node:crypto';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function commandRequestHash(value: Record<string, unknown>): string {
  return sha256(canonicalJson(value));
}

export function commandKeyHash(value: string | undefined): string {
  return sha256(value ?? randomUUID());
}
