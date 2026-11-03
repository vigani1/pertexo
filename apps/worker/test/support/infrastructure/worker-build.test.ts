import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { requireCurrentWorkerBuild } from './worker-build.js';

it('requires a current emitted build and refuses a missing output even when build metadata exists', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pertexo-worker-build-'));
  const project = join(directory, 'tsconfig.json');
  const source = join(directory, 'src', 'runtime.ts');
  const output = join(directory, 'dist', 'runtime.js');
  try {
    await mkdir(join(directory, 'src'));
    await writeFile(
      project,
      JSON.stringify({
        compilerOptions: {
          composite: true,
          rootDir: 'src',
          outDir: 'dist',
          types: [],
          skipLibCheck: true,
        },
        include: ['src/**/*.ts'],
      }),
    );
    await writeFile(source, 'export const version = 1;');
    expect(() => {
      requireCurrentWorkerBuild(project);
    }).toThrow(/pnpm build:packages --force/u);
    const build = () => {
      expect(
        ts
          .createSolutionBuilder(ts.createSolutionBuilderHost(), [project], {
            force: true,
          })
          .build(),
      ).toBe(0);
    };
    build();
    expect(() => {
      requireCurrentWorkerBuild(project);
    }).not.toThrow();
    await writeFile(source, 'export const version = 2;');
    expect(() => {
      requireCurrentWorkerBuild(project);
    }).toThrow(/pnpm build:packages --force/u);
    build();
    expect(await readFile(output, 'utf8')).toContain('version = 2');
    expect(() => {
      requireCurrentWorkerBuild(project);
    }).not.toThrow();
    await unlink(output);
    expect(() => {
      requireCurrentWorkerBuild(project);
    }).toThrow(/pnpm build:packages --force/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
