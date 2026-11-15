import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

// How long a snapshot stays fresh or cached and how often a screen asks again
// come from lib/api/query-timings.ts, or a constant named beside a timing that
// is truly its feature's own. A number written into a query's options fails.
const TIMING_KEYS = new Set([
  'staleTime',
  'gcTime',
  'refetchInterval',
  'retryDelay',
]);
const OWNER = 'lib/api/query-timings.ts';

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/u.test(name) ? [path] : [];
  });
}

function literalTimings(path: string, text: string): string[] {
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const numbersIn = (node: ts.Node, key: string) => {
    // Element access (`items[0]`) picks an entry; it is not a timing.
    if (ts.isElementAccessExpression(node)) {
      numbersIn(node.expression, key);
      return;
    }
    if (
      ts.isNumericLiteral(node) ||
      (ts.isIdentifier(node) && node.text === 'Infinity')
    )
      found.push(`${key}: ${node.getText(source)}`);
    ts.forEachChild(node, (child) => {
      numbersIn(child, key);
    });
  };
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node)) {
      const key = node.name.getText(source);
      if (TIMING_KEYS.has(key)) numbersIn(node.initializer, key);
      else if (key === 'retry' && ts.isNumericLiteral(node.initializer))
        found.push(`retry: ${node.initializer.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function writtenTimings(root: string): string[] {
  return sources(root)
    .filter((path) => relative(root, path) !== OWNER)
    .flatMap((path) =>
      literalTimings(path, readFileSync(path, 'utf8')).map(
        (timing) => `${relative(root, path)}: ${timing}`,
      ),
    );
}

it('takes every query timing from a named owner', () => {
  expect(writtenTimings(join(import.meta.dirname, '../../src'))).toEqual([]);
});

it('catches a number written into a query timing', () => {
  expect(
    literalTimings(
      'planted.ts',
      [
        'const a = { staleTime: 30_000, gcTime: 5 * 60_000, retry: 2 };',
        'const b = { refetchInterval: (q) => (q.ok ? 2000 : false) };',
        'const c = { staleTime: Infinity, refetchInterval: (q) => q.items[0] };',
        'const d = { staleTime: QUERY_FRESHNESS.standard, retry: false };',
      ].join('\n'),
    ),
  ).toEqual([
    'staleTime: 30_000',
    'gcTime: 5',
    'gcTime: 60_000',
    'retry: 2',
    'refetchInterval: 2000',
    'staleTime: Infinity',
  ]);
});
