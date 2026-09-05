import type {
  DefinitionIdentity,
  ExecutorIdentity,
  PolicyReference,
} from './release.js';

export type CompatibilityIdentity =
  DefinitionIdentity | ExecutorIdentity | PolicyReference;

export function identityToken(identity: CompatibilityIdentity): string {
  return `${identity.key}\u0000${String(identity.version)}`;
}

export function compareIdentity(
  left: CompatibilityIdentity,
  right: CompatibilityIdentity,
): number {
  return left.key < right.key
    ? -1
    : left.key > right.key
      ? 1
      : left.version - right.version;
}

export function sameIdentity(
  left: CompatibilityIdentity,
  right: CompatibilityIdentity,
): boolean {
  return left.key === right.key && left.version === right.version;
}
