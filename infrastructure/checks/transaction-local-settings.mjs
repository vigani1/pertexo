import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// Transactions no longer prove a pooled client is clean before and after use:
// they rely on every setting being transaction-local. A session-level setting
// would outlive its transaction and reach the client's next user, so the code
// may not make one.

const root = path.resolve(import.meta.dirname, '../..');

const SOURCE_FILE = /\.(?:[cm]?[jt]s|tsx)$/u;

/** Tests own dedicated clients; migrations own the schema session. */
function inScope(file) {
  return (
    SOURCE_FILE.test(file) &&
    !file.startsWith('packages/database/migrations/') &&
    !/(?:^|\/)test\//u.test(file) &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file) &&
    !/fixture/u.test(file)
  );
}

/** Code that sets session state on a connection no pool ever hands out again. */
export const SESSION_SETTING_EXEMPTIONS = Object.freeze({
  'packages/database/src/migrations.ts':
    'The migration runner sets its timeouts and owner role on a dedicated one-client pool that it ends after migrating.',
  'infrastructure/single-server/backup/qualify.mjs':
    'Backup qualification runs each check through a one-shot psql session against a restored copy.',
});

/** Finds session-level settings in the SQL text of one JavaScript or TypeScript file. */
export function findSessionSettings(fileName, source) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const found = [];
  const visit = (node) => {
    const text = literalText(node);
    if (text !== undefined) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      for (const statement of sessionSettings(text))
        found.push({ line: line + 1, statement });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isTemplateExpression(node))
    // An interpolation stands for one SQL value.
    return [
      node.head.text,
      ...node.templateSpans.map((span) => span.literal.text),
    ].join('$x');
  return undefined;
}

// A whole SET statement, so prose such as "set NODE_ENV to production, then"
// is not mistaken for one. SET LOCAL, SET TRANSACTION and SET CONSTRAINTS end
// with the transaction and don't match.
const VALUE = String.raw`(?:'[^']*'|"[^"]*"|[\w.$-]+)`;
const SESSION_SET = new RegExp(
  String.raw`^set\s+(?:session\s+)?(?:role\s+${VALUE}|session\s+authorization\s+${VALUE}|time\s+zone\s+${VALUE}|(?!local\b|transaction\b|constraints\b)[a-z_][\w.]*\s*(?:=|\sto\s)\s*${VALUE}(?:\s*,\s*${VALUE})*)$`,
  'iu',
);

function sessionSettings(sql) {
  const found = [];
  for (const statement of sql.split(';')) {
    const trimmed = statement.trim().replaceAll(/\s+/gu, ' ');
    if (SESSION_SET.test(trimmed)) found.push(trimmed);
  }
  for (const call of setConfigCalls(sql))
    if (call.lastArgument.toLowerCase() !== 'true') found.push(call.text);
  return found;
}

function* setConfigCalls(sql) {
  const pattern = /\bset_config\s*\(/giu;
  for (const match of sql.matchAll(pattern)) {
    const start = match.index + match[0].length;
    let depth = 0;
    let quote;
    let argumentStart = start;
    for (let index = start; index < sql.length; index += 1) {
      const char = sql[index];
      if (quote !== undefined) {
        if (char === quote) quote = undefined;
        continue;
      }
      if (char === "'" || char === '"') quote = char;
      else if (char === '(') depth += 1;
      else if (char === ',' && depth === 0) argumentStart = index + 1;
      else if (char === ')') {
        if (depth === 0) {
          yield {
            text: sql.slice(match.index, index + 1),
            lastArgument: sql.slice(argumentStart, index).trim(),
          };
          break;
        }
        depth -= 1;
      }
    }
  }
}

export async function validateTransactionLocalSettings() {
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter((file) => file !== '' && inScope(file));
  const violations = [];
  const usedExemptions = new Set();
  let checked = 0;
  for (const file of files) {
    let source;
    try {
      source = await readFile(path.join(root, file), 'utf8');
    } catch (error) {
      // A deleted file still listed by the index has nothing to check.
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    checked += 1;
    const found = findSessionSettings(file, source);
    if (Object.hasOwn(SESSION_SETTING_EXEMPTIONS, file)) {
      if (found.length > 0) usedExemptions.add(file);
      continue;
    }
    for (const { line, statement } of found)
      violations.push(`${file}:${String(line)}: ${statement}`);
  }
  for (const file of Object.keys(SESSION_SETTING_EXEMPTIONS))
    if (!usedExemptions.has(file))
      violations.push(`${file}: exemption no longer needed; remove it`);
  if (violations.length > 0)
    throw new Error(
      `Session-level settings outlive their transaction on a pooled client; use set_config with is_local true or SET LOCAL:\n${violations.join('\n')}`,
    );
  return Object.freeze({ checked });
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  validateTransactionLocalSettings()
    .then(({ checked }) => {
      console.log(
        `Transaction-local settings check passed (${String(checked)} files).`,
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
