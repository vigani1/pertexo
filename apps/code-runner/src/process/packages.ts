import { createRequire, isBuiltin } from 'node:module';
import { dirname, join, parse } from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import {
  CODE_DEFAULT_PACKAGES,
  CODE_ALLOWED_BUILTINS,
  type CodeSettings,
} from '@pertexo/node-sdk';
import type { ModulePolicy } from '../execution/modules.js';

type Manifest = Readonly<{
  name?: string;
  dependencies?: Readonly<Record<string, string>>;
  optionalDependencies?: Readonly<Record<string, string>>;
}>;
/** Resolve installed package files without evaluating package code in the manager. */
export async function resolveCodePackages(
  settings: CodeSettings,
): Promise<ModulePolicy> {
  const packages = [
    ...new Set([...CODE_DEFAULT_PACKAGES, ...settings.extraPackages]),
  ];
  const roots = new Set<string>();
  const reads = new Set<string>();
  const visited = new Set<string>();
  const queue = [
    ...packages.map((name) => ({
      name,
      from: import.meta.url,
      optional: false,
      allowed: true,
    })),
    {
      name: '@pertexo/node-sdk',
      from: import.meta.url,
      optional: false,
      allowed: false,
    },
  ];
  let index = 0;
  while (index < queue.length) {
    const item = queue[index++];
    if (item === undefined) continue;
    if (isBuiltin(item.name))
      throw new Error('Extra Code packages must be installed npm packages');
    let entry: string;
    try {
      entry = await realpath(createRequire(item.from).resolve(item.name));
    } catch (error: unknown) {
      if (item.optional) continue;
      throw new Error('An allowed Code package is not installed', {
        cause: error,
      });
    }
    let root = dirname(entry),
      manifest: Manifest | undefined;
    for (;;) {
      try {
        const candidate = JSON.parse(
          await readFile(join(root, 'package.json'), 'utf8'),
        ) as Manifest;
        if (candidate.name === item.name) {
          manifest = candidate;
          break;
        }
      } catch (error: unknown) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ))
          throw error;
      }
      if (root === parse(root).root)
        throw new Error('An allowed Code package has no manifest');
      root = dirname(root);
    }
    if (item.allowed) roots.add(root);
    reads.add(root);
    const resolver = createRequire(item.from);
    for (const search of resolver.resolve.paths(item.name) ?? []) {
      const alias = join(search, item.name);
      if ((await realpath(alias).catch(() => undefined)) === root)
        reads.add(alias);
    }
    const key = root + String(item.allowed);
    if (visited.has(key)) continue;
    visited.add(key);
    for (const name of Object.keys(manifest.dependencies ?? {}))
      queue.push({
        name,
        from: join(root, 'package.json'),
        optional: false,
        allowed: item.allowed,
      });
    for (const name of Object.keys(manifest.optionalDependencies ?? {}))
      queue.push({
        name,
        from: join(root, 'package.json'),
        optional: true,
        allowed: item.allowed,
      });
  }
  return Object.freeze({
    packages,
    builtins: CODE_ALLOWED_BUILTINS,
    roots: [...roots],
    readPaths: [...reads],
  });
}
