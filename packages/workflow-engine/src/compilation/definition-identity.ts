import type {
  DefinitionIdentity,
  ExecutorIdentity,
  PolicyReference,
} from '@pertexo/node-sdk';
export const token = (
  value: DefinitionIdentity | ExecutorIdentity | PolicyReference,
): string => `${value.key}\u0000${String(value.version)}`;
export function compareIdentity(
  left: DefinitionIdentity | ExecutorIdentity | PolicyReference,
  right: DefinitionIdentity | ExecutorIdentity | PolicyReference,
): number {
  if (left.key < right.key) return -1;
  if (left.key > right.key) return 1;
  return left.version - right.version;
}
export const sameIdentity = (
  left: DefinitionIdentity | ExecutorIdentity | PolicyReference,
  right: DefinitionIdentity | ExecutorIdentity | PolicyReference,
): boolean => left.key === right.key && left.version === right.version;
