import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const supportedSurfaces = [
  'api',
  'execution',
  'lifecycle',
  'maintenance',
  'operator',
  'recovery',
] as const;

describe('@pertexo/database package contract', () => {
  it('publishes explicit runtime-role capability surfaces', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      readonly exports: Readonly<
        Record<string, Readonly<{ default: string; types: string }>>
      >;
    };

    expect(Object.keys(packageJson.exports).sort()).toEqual([
      '.',
      ...supportedSurfaces.map((surface) => `./${surface}`),
    ]);
    for (const surface of supportedSurfaces)
      expect(packageJson.exports[`./${surface}`]).toEqual({
        types: `./dist/${surface}.d.ts`,
        default: `./dist/${surface}.js`,
      });
  });

  it('keeps role surfaces independent from the broad compatibility root', async () => {
    for (const surface of supportedSurfaces) {
      const source = await readFile(
        new URL(`../src/${surface}.ts`, import.meta.url),
        'utf8',
      );
      expect(source).not.toContain("from './index.js'");
    }

    const api = await readFile(
      new URL('../src/api.ts', import.meta.url),
      'utf8',
    );
    const execution = await readFile(
      new URL('../src/execution.ts', import.meta.url),
      'utf8',
    );
    const maintenance = await readFile(
      new URL('../src/maintenance.ts', import.meta.url),
      'utf8',
    );
    expect(api).not.toContain('createCoordinatorRunStore');
    expect(execution).not.toContain('createIdentityWorkspaceDatabase');
    expect(maintenance).not.toContain('createControlLedgerCoordinator');
  });
});
