import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));

const forbiddenCrossings = Object.freeze([
  ['node-testing', '../workflow-authoring/'],
  ['workflow-authoring', '../node-testing/'],
  ['schedules', '../workflow-authoring/'],
  ['webhooks', '../workflow-authoring/'],
  ['platform/webhooks', '../../workflow-runs/'],
] as const);

describe('API feature import boundaries', () => {
  it.each(forbiddenCrossings)(
    '%s does not import %s internals',
    (owner, forbiddenSpecifier) => {
      const violations = sourceFiles(join(sourceRoot, owner)).flatMap((file) =>
        readFileSync(file, 'utf8').includes(forbiddenSpecifier)
          ? [relative(sourceRoot, file)]
          : [],
      );
      expect(violations).toEqual([]);
    },
  );
});

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && extname(entry.name) === '.ts' ? [path] : [];
  });
}
