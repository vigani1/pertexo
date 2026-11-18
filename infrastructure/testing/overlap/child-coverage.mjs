import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { isBuiltFile } from './source-lines.mjs';

// Reads the V8 coverage Node wrote for the processes a test file started
// (NODE_V8_COVERAGE) and adds each built file's executed statements to the
// file's reach. Statements follow Vitest's own rule: those inside a function
// whose innermost V8 range ran. Source files run through a loader (`tsx`) are
// skipped: V8 counts offsets in the transformed text, which is not on disk.

// As in Istanbul, a function declaration is not a statement; its body's are.

const STATEMENTS = new Set([
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.ExpressionStatement,
  ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.ThrowStatement,
  ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.BreakStatement,
  ts.SyntaxKind.ContinueStatement,
  ts.SyntaxKind.LabeledStatement,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.DebuggerStatement,
]);

/** Adds what the processes recorded in `directory` executed to `reach`. */
export function addChildCoverage(reach, directory, root) {
  if (!existsSync(directory)) return;
  const statements = new Map();
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.json')) continue;
    const { result } = JSON.parse(readFileSync(join(directory, name), 'utf8'));
    for (const { url, functions } of result) {
      if (!url.startsWith('file:')) continue;
      const absolute = fileURLToPath(url);
      if (!isBuiltFile(absolute, root)) continue;
      const parsed = statements.get(absolute) ?? statementsOf(absolute);
      statements.set(absolute, parsed);
      reach.add(absolute, executedInFunctions(parsed, functions));
    }
  }
}

/** Statement starts of a JavaScript file, in offset order. */
function statementsOf(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const found = [];
  const record = (node) => {
    const offset = node.getStart(source);
    const { line, character } = source.getLineAndCharacterOfPosition(offset);
    found.push({ offset, line: line + 1, column: character });
  };
  const visit = (node) => {
    if (STATEMENTS.has(node.kind)) record(node);
    // An arrow function's expression body is its one statement.
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) record(node.body);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found.sort((a, b) => a.offset - b.offset);
}

/**
 * The statements that ran inside a function, by V8's block coverage: a
 * statement's count is its innermost range's, and a statement whose innermost
 * function is the script itself is top level (or in a function V8 never
 * compiled) and does not count.
 */
function executedInFunctions(statements, functions) {
  const ranges = functions
    .flatMap(({ ranges: own }) =>
      own.map((range, index) => ({
        ...range,
        isFunction: index === 0,
        isScript: index === 0 && range.startOffset === 0,
      })),
    )
    .sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  const open = [];
  const executed = [];
  let next = 0;
  for (const statement of statements) {
    while (
      next < ranges.length &&
      ranges[next].startOffset <= statement.offset
    ) {
      closeAt(open, ranges[next].startOffset);
      open.push(ranges[next++]);
    }
    closeAt(open, statement.offset);
    const innermost = open.at(-1);
    const within = open.findLast((range) => range.isFunction);
    if (innermost && within && !within.isScript && innermost.count > 0)
      executed.push({ line: statement.line, column: statement.column });
  }
  return executed;
}

/** Closes the open ranges that end at or before `offset` (V8 ends are exclusive). */
function closeAt(open, offset) {
  while (open.length > 0 && open.at(-1).endOffset <= offset) open.pop();
}
