import console from 'node:console';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export const repositoryRoot = path.resolve(import.meta.dirname, '../..');

/** Every app and package directory, as `apps/<name>` or `packages/<name>`. */
export async function listWorkspaces(root = repositoryRoot) {
  const workspaces = [];
  for (const category of ['apps', 'packages'])
    for (const entry of await directoryEntries(path.join(root, category)))
      if (entry.isDirectory()) workspaces.push(`${category}/${entry.name}`);
  return workspaces.sort();
}

export async function directoryEntries(directory) {
  try {
    if (!(await lstat(directory)).isDirectory()) return [];
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

/** Print a check's findings and set the exit code. */
export function report(findings, success) {
  if (findings.length === 0) {
    console.log(success);
    return;
  }
  for (const finding of findings) console.error(finding);
  process.exitCode = 1;
}
