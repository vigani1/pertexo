import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';

// Text sizes come from the type scale (globals.css `--text-*` and
// Tailwind's own). The one written size left is lettering drawn inside the
// file chip's icon, not text.
const DRAWN = new Set(['features/artifacts/components/file-chip.tsx']);

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/u.test(name) ? [path] : [];
  });
}

it('sizes text from the type scale, not written sizes', () => {
  const root = join(import.meta.dirname, '../../src');
  const written = sources(root).flatMap((path) => {
    const file = relative(root, path);
    if (DRAWN.has(file)) return [];
    const sizes = readFileSync(path, 'utf8').match(
      /\btext-\[\d*\.?\d+(?:rem|px|em)\]/gu,
    );
    return sizes === null ? [] : [`${file}: ${sizes.join(' ')}`];
  });
  expect(written).toEqual([]);
});
