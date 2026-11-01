import type { DirectoryMapping, DirectoryRole } from './contract.js';

/** Mapping order is explicit: builder and operator are not a privilege ladder. */
export function directoryRole(
  mappings: readonly DirectoryMapping[],
  groups: ReadonlySet<string>,
  fallback: DirectoryRole,
): DirectoryRole {
  return (
    mappings.find((mapping) => groups.has(mapping.groupId))?.role ?? fallback
  );
}
