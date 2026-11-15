import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

// How long a snapshot stays fresh or cached, how often a screen asks again
// and how often a clock ticks come from one owner each:
// lib/api/query-timings.ts and CLOCK_TICK in lib/hooks/use-now.ts. A number
// written into those options fails here, however it is spelled: a literal,
// a constant named in the same file, a shorthand property, Infinity or a
// retry rule written as a function.
const TIMING_KEYS = new Set([
  'staleTime',
  'gcTime',
  'refetchInterval',
  'retryDelay',
  'intervalMs',
]);
const OWNERS = new Set(['lib/api/query-timings.ts', 'lib/hooks/use-now.ts']);

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/u.test(name) ? [path] : [];
  });
}

// Module or function constants whose value is a number written by hand.
function numericConstants(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isWrittenNumber(node.initializer)
    )
      names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function isWrittenNumber(node: ts.Expression): boolean {
  if (ts.isNumericLiteral(node)) return true;
  if (ts.isParenthesizedExpression(node))
    return isWrittenNumber(node.expression);
  return (
    ts.isBinaryExpression(node) &&
    isWrittenNumber(node.left) &&
    isWrittenNumber(node.right)
  );
}

function literalTimings(path: string, text: string): string[] {
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const named = numericConstants(source);
  const found: string[] = [];
  const numbersIn = (node: ts.Node, key: string) => {
    // Element access (`items[0]`) picks an entry; it is not a timing.
    if (ts.isElementAccessExpression(node)) {
      numbersIn(node.expression, key);
      return;
    }
    if (
      ts.isNumericLiteral(node) ||
      (ts.isIdentifier(node) &&
        (node.text === 'Infinity' || named.has(node.text))) ||
      (ts.isPropertyAccessExpression(node) &&
        node.getText(source) === 'Number.POSITIVE_INFINITY')
    ) {
      found.push(`${key}: ${node.getText(source)}`);
      return;
    }
    ts.forEachChild(node, (child) => {
      numbersIn(child, key);
    });
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isShorthandPropertyAssignment(node) &&
      TIMING_KEYS.has(node.name.text)
    )
      found.push(`${node.name.text}: shorthand`);
    if (ts.isPropertyAssignment(node)) {
      const key = node.name.getText(source);
      if (TIMING_KEYS.has(key)) numbersIn(node.initializer, key);
      else if (key === 'retry' && isQueryRetry(node.initializer))
        numbersIn(node.initializer, 'retry');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// A query's retry: a count, or a rule given the failure count. A step's
// retry settings object or a screen's Retry action is something else.
function isQueryRetry(node: ts.Expression): boolean {
  if (ts.isNumericLiteral(node) || ts.isIdentifier(node)) return true;
  return (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    node.parameters.length > 0
  );
}

function writtenTimings(root: string): string[] {
  return sources(root)
    .filter((path) => !OWNERS.has(relative(root, path)))
    .flatMap((path) =>
      literalTimings(path, readFileSync(path, 'utf8')).map(
        (timing) => `${relative(root, path)}: ${timing}`,
      ),
    );
}

it('takes every query timing and clock tick from a named owner', () => {
  expect(writtenTimings(join(import.meta.dirname, '../../src'))).toEqual([]);
});

it('catches a number written into a timing however it is spelled', () => {
  expect(
    literalTimings(
      'planted.ts',
      [
        'const LIVE_REFRESH_MS = 10_000;',
        'const staleTime = 5;',
        'const a = { staleTime: 30_000, gcTime: 5 * 60_000, retry: 2 };',
        'const b = { refetchInterval: (q) => (q.ok ? 2000 : false) };',
        'const c = { staleTime: Infinity, refetchInterval: (q) => q.items[0] };',
        'const d = { staleTime: QUERY_FRESHNESS.standard, retry: false };',
        'const e = { refetchInterval: LIVE_REFRESH_MS, staleTime };',
        'const f = { gcTime: Number.POSITIVE_INFINITY, retry: (n) => n < 3 };',
        'const g = { intervalMs: 60_000, enabled: true };',
      ].join('\n'),
    ),
  ).toEqual([
    'staleTime: 30_000',
    'gcTime: 5',
    'gcTime: 60_000',
    'retry: 2',
    'refetchInterval: 2000',
    'staleTime: Infinity',
    'refetchInterval: LIVE_REFRESH_MS',
    'staleTime: shorthand',
    'gcTime: Number.POSITIVE_INFINITY',
    'retry: 3',
    'intervalMs: 60_000',
  ]);
});
