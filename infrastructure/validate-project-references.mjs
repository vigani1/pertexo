import console from 'node:console';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');

/** Validate the build graph against the runtime workspace dependency graph. */
export function validateProjectReferences(workspaces, rootReferences) {
  const errors = [];
  const byName = new Map(
    workspaces.map((workspace) => [workspace.name, workspace]),
  );
  const normalize = (directory, reference) => {
    const resolved = path.posix.normalize(
      path.posix.join(directory, reference.path),
    );
    return resolved.endsWith('/tsconfig.json')
      ? resolved.slice(0, -'/tsconfig.json'.length)
      : resolved;
  };
  const compare = (owner, actual, expected) => {
    if (actual.length !== new Set(actual).size)
      errors.push(`${owner}: duplicate project reference`);
    for (const target of expected)
      if (!actual.includes(target))
        errors.push(`${owner}: missing reference to ${target}`);
    for (const target of actual)
      if (!expected.includes(target))
        errors.push(`${owner}: unexpected reference to ${target}`);
  };
  compare(
    'root',
    rootReferences.map((reference) => normalize('.', reference)),
    workspaces.map((workspace) => workspace.directory),
  );
  for (const workspace of workspaces) {
    const dependencies = Object.entries(workspace.dependencies ?? {}).filter(
      ([name, version]) => byName.has(name) || version.startsWith('workspace:'),
    );
    const expected = [];
    for (const [name] of dependencies) {
      const target = byName.get(name);
      if (target === undefined)
        errors.push(`${workspace.name}: unknown workspace dependency ${name}`);
      else {
        expected.push(target.directory);
        if (target.directory.startsWith('apps/'))
          errors.push(
            `${workspace.name}: cannot depend on deployable application ${name}`,
          );
      }
    }
    compare(
      workspace.name,
      workspace.references.map((reference) =>
        normalize(workspace.directory, reference),
      ),
      expected,
    );
  }
  const completed = new Set();
  const active = new Set();
  const visit = (name, trail) => {
    if (active.has(name)) {
      errors.push(
        `workspace dependency cycle: ${[...trail, name].join(' -> ')}`,
      );
      return;
    }
    if (completed.has(name)) return;
    active.add(name);
    for (const dependency of Object.keys(byName.get(name)?.dependencies ?? {}))
      if (byName.has(dependency)) visit(dependency, [...trail, name]);
    active.delete(name);
    completed.add(name);
  };
  for (const workspace of workspaces) visit(workspace.name, []);
  return errors;
}

export async function inspectProjectReferences(directory = root) {
  const readJson = async (file) =>
    JSON.parse(await readFile(path.join(directory, file), 'utf8'));
  const workspaces = [];
  for (const category of ['apps', 'packages']) {
    for (const entry of await readdir(path.join(directory, category), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const workspaceDirectory = `${category}/${entry.name}`;
      let manifest;
      try {
        manifest = await readJson(`${workspaceDirectory}/package.json`);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      const config = await readJson(`${workspaceDirectory}/tsconfig.json`);
      workspaces.push({
        name: manifest.name,
        directory: workspaceDirectory,
        dependencies: manifest.dependencies,
        references: config.references ?? [],
      });
    }
  }
  const config = await readJson('tsconfig.json');
  return validateProjectReferences(workspaces, config.references ?? []);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const errors = await inspectProjectReferences();
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else
    console.log(
      'Workspace dependency and TypeScript project reference graphs agree.',
    );
}
