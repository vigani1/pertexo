import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { formatCount, pluralWord } from '@/lib/format/count';

it('puts words in the number their count needs', () => {
  expect(pluralWord(1, 'step')).toBe('step');
  expect(pluralWord(0, 'step')).toBe('steps');
  expect(pluralWord(2, 'is', 'are')).toBe('are');
  expect(formatCount(1, 'entry', 'entries')).toBe('1 entry');
  expect(formatCount(12_000, 'entry', 'entries')).toBe('12,000 entries');
});

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/u.test(name) ? [path] : [];
  });
}

const isText = (node: ts.Node): boolean =>
  ts.isStringLiteral(node) ||
  ts.isNoSubstitutionTemplateLiteral(node) ||
  ts.isTemplateExpression(node) ||
  (ts.isParenthesizedExpression(node) && isText(node.expression));

/** `count === 1 ? 'step' : 'steps'`: a plural chosen by hand. */
function isHandWrittenPlural(node: ts.Node): boolean {
  if (!ts.isConditionalExpression(node)) return false;
  const { condition } = node;
  const comparesWithOne =
    ts.isBinaryExpression(condition) &&
    [
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ].includes(condition.operatorToken.kind) &&
    [condition.left, condition.right].some(
      (side) => ts.isNumericLiteral(side) && side.text === '1',
    );
  return comparesWithOne && isText(node.whenTrue) && isText(node.whenFalse);
}

function handWrittenPlurals(root: string): string[] {
  return sources(root).flatMap((path) => {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const found: string[] = [];
    const visit = (node: ts.Node) => {
      if (isHandWrittenPlural(node)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        found.push(`${relative(root, path)}:${String(line + 1)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  });
}

// One way to pluralize: pluralWord and formatCount, on Intl.PluralRules.
it('chooses plurals through pluralWord, never by hand', () => {
  expect(handWrittenPlurals(join(import.meta.dirname, '../../src'))).toEqual(
    [],
  );
});
