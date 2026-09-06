// @ts-check

/**
 * @typedef {{
 *   name: string;
 *   scripts?: { build?: string };
 *   dependencies?: Record<string, string>;
 * }} PackageManifest
 */

/** @typedef {{ directory: string; packageManifest: PackageManifest }} Workspace */

/** @typedef {Map<string, Workspace>} WorkspaceManifestMap */

/** @typedef {Map<string, string>} CommandMap */

/** @type {CommandMap} */
export const expectedCommands = new Map([
  ['api', 'apps/api/dist/main.js'],
  ['worker', 'apps/worker/dist/main.js'],
  ['lifecycle-command', 'apps/lifecycle-command/dist/main.js'],
  ['retention', 'apps/retention/dist/main.js'],
  ['recovery', 'apps/recovery/dist/main.js'],
  ['operator-command', 'apps/operator-command/dist/main.js'],
  ['migration', 'packages/database/dist/migrate.js'],
]);

/**
 * @param {WorkspaceManifestMap} workspaceByName
 * @param {string} workloadName
 * @returns {Workspace}
 */
function runtimeWorkspaceFor(workspaceByName, workloadName) {
  const packageName = `@pertexo/${workloadName}`;
  const workspace = workspaceByName.get(packageName);
  if (workspace === undefined)
    throw new Error(`missing runtime workspace ${packageName}`);
  return workspace;
}

/**
 * @param {CommandMap} expectedCommands
 * @param {WorkspaceManifestMap} workspaceByName
 * @returns {WorkspaceManifestMap}
 */
export function collectRuntimeWorkspaces(expectedCommands, workspaceByName) {
  if (!(expectedCommands instanceof Map))
    throw new TypeError('expected commands must be a Map');
  if (!(workspaceByName instanceof Map))
    throw new TypeError('workspace manifests must be a Map');

  const pending = [...expectedCommands.keys()]
    .filter((name) => name !== 'migration')
    .map((name) => runtimeWorkspaceFor(workspaceByName, name));
  pending.push(runtimeWorkspaceFor(workspaceByName, 'database'));

  const runtimeWorkspaces = new Map();
  while (pending.length > 0) {
    const workspace = pending.pop();
    if (workspace === undefined)
      throw new Error('runtime workspace queue unexpectedly empty');
    if (runtimeWorkspaces.has(workspace.packageManifest.name)) continue;
    runtimeWorkspaces.set(workspace.packageManifest.name, workspace);
    for (const dependencyName of Object.keys(
      workspace.packageManifest.dependencies ?? {},
    )) {
      const dependency = workspaceByName.get(dependencyName);
      if (dependency !== undefined) pending.push(dependency);
    }
  }
  return runtimeWorkspaces;
}

/**
 * @param {string} dockerfile
 * @param {WorkspaceManifestMap} runtimeWorkspaces
 * @returns {void}
 */
export function validateRuntimeClosure(dockerfile, runtimeWorkspaces) {
  if (!(runtimeWorkspaces instanceof Map))
    throw new TypeError('runtime workspaces must be a Map');
  for (const { directory, packageManifest } of runtimeWorkspaces.values()) {
    if (packageManifest.scripts?.build === undefined) continue;
    const expectedCopy = `/workspace/${directory}/dist ./${directory}/dist`;
    if (!dockerfile.includes(expectedCopy))
      throw new Error(
        `runtime image is missing built workspace dependency ${packageManifest.name}`,
      );
  }
}
