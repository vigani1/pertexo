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
// may not make one. The check fails closed: any SQL it can't prove
// transaction-local is a finding, and a literal that only looks like SQL needs
// an exemption marker with its reason.

const root = path.resolve(import.meta.dirname, '../..');

const SOURCE_FILE = /\.(?:[cm]?[jt]s|tsx)$/u;

/** A line comment on the line of, or the line above, a literal, naming its reason. */
const EXEMPTION_MARKER = /\/\/\s*session-setting-exempt:\s*(\S.*)$/u;

/** Code that sets session state on a connection no pool ever hands out again. */
export const SESSION_SETTING_EXEMPTIONS = Object.freeze({
  'packages/database/src/migrations.ts':
    'The migration runner sets its timeouts and owner role on a dedicated one-client pool that it ends after migrating.',
  'infrastructure/single-server/backup/qualify.mjs':
    'Backup qualification runs each check through a one-shot psql session against a restored copy.',
});

/** Finds SQL in one JavaScript or TypeScript file that could leave session state behind. */
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
    if (text !== undefined && !isNonSqlWord(node, text)) {
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

/** Findings left once exemption markers are applied, plus markers that exempt nothing. */
export function unexemptedSessionSettings(fileName, source) {
  const lines = source.split('\n');
  const markers = new Map();
  lines.forEach((text, index) => {
    const reason = EXEMPTION_MARKER.exec(text)?.[1];
    if (reason !== undefined) markers.set(index + 1, false);
  });
  const findings = [];
  for (const finding of findSessionSettings(fileName, source)) {
    const marker = [finding.line, finding.line - 1].find((line) =>
      markers.has(line),
    );
    if (marker === undefined) findings.push(finding);
    else markers.set(marker, true);
  }
  for (const [line, used] of markers)
    if (!used)
      findings.push({
        line,
        statement: 'exemption marker exempts nothing; remove it',
      });
  return findings;
}

function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isTemplateExpression(node))
    // An interpolation stands for one unknown piece of SQL.
    return [
      node.head.text,
      ...node.templateSpans.map((span) => span.literal.text),
    ].join('$x');
  return undefined;
}

/**
 * Words that are values, not SQL: a lone "set" or "reset" that isn't a piece
 * of a larger string, and a foreign key's "set null" action.
 */
function isNonSqlWord(node, text) {
  const parent = node.parent;
  const joined =
    (ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
    ts.isArrayLiteralExpression(parent) ||
    ts.isTemplateSpan(parent);
  if (/^(?:set|reset)$/iu.test(text) && !joined) return true;
  return /^set null$/u.test(text) && isForeignKeyAction(parent);
}

function isForeignKeyAction(parent) {
  const name = ts.isPropertyAssignment(parent)
    ? parent.name.getText()
    : ts.isCallExpression(parent) &&
        ts.isPropertyAccessExpression(parent.expression)
      ? parent.expression.name.text
      : undefined;
  return name === 'onDelete' || name === 'onUpdate';
}

const LEADING_COMMENTS = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/u;
// SET LOCAL, SET TRANSACTION and SET CONSTRAINTS end with the transaction.
const TRANSACTION_SCOPED_SET = /^set\s+(?:local|transaction|constraints)\b/iu;
// A DO block runs SQL this check can't read.
const ANONYMOUS_BLOCK = /^do\s+(?:language\s+\S+\s+)?['$]/iu;

function sessionSettings(sql) {
  const found = [];
  for (const statement of sql.split(';')) {
    const text = statement
      .replace(LEADING_COMMENTS, '')
      .replaceAll(/\s+/gu, ' ')
      .trim();
    if (
      (/^(?:set|reset)(?:\s|$)/iu.test(text) &&
        !TRANSACTION_SCOPED_SET.test(text)) ||
      ANONYMOUS_BLOCK.test(text)
    )
      found.push(text);
  }
  for (const call of setConfigCalls(sql))
    if (!call.local) found.push(call.text);
  return found;
}

/** Every set_config mention, local only when it is a closed call whose third argument is literally true. */
function* setConfigCalls(sql) {
  for (const match of sql.matchAll(/\bset_config\b/giu)) {
    const open = /^\s*\(/u.exec(sql.slice(match.index + match[0].length));
    if (open === null) {
      yield { text: sql.slice(match.index).split('\n')[0], local: false };
      continue;
    }
    const start = match.index + match[0].length + open[0].length;
    const args = [];
    let depth = 0;
    let quote;
    let argumentStart = start;
    let end;
    for (let index = start; index < sql.length; index += 1) {
      const char = sql[index];
      if (quote !== undefined) {
        if (char === quote) quote = undefined;
        continue;
      }
      if (char === "'" || char === '"') quote = char;
      else if (char === '(') depth += 1;
      else if (char === ',' && depth === 0) {
        args.push(sql.slice(argumentStart, index).trim());
        argumentStart = index + 1;
      } else if (char === ')') {
        if (depth === 0) {
          args.push(sql.slice(argumentStart, index).trim());
          end = index + 1;
          break;
        }
        depth -= 1;
      }
    }
    // An unclosed call is being assembled elsewhere, so its flag is unknown.
    if (end === undefined) {
      yield { text: sql.slice(match.index).split('\n')[0], local: false };
      continue;
    }
    yield {
      text: sql.slice(match.index, end),
      local: args.length === 3 && args[2].toLowerCase() === 'true',
    };
  }
}

/** Files a pooled client can run: tests excluded, and packages that can't reach pg. */
function scopeFilter() {
  const manifests = execFileSync(
    'git',
    ['ls-files', '-z', '--', 'package.json', '*/package.json'],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter((file) => file !== '' && file !== 'package.json');
  const packages = new Map();
  for (const manifest of manifests) {
    const json = JSON.parse(
      execFileSync('git', ['show', `:${manifest}`], {
        cwd: root,
        encoding: 'utf8',
      }),
    );
    packages.set(json.name, {
      directory: path.dirname(manifest),
      dependencies: Object.keys({
        ...json.dependencies,
        ...json.peerDependencies,
        ...json.optionalDependencies,
      }),
    });
  }
  const reachesPostgres = new Map();
  const reaches = (name, seen = new Set()) => {
    if (name === 'pg') return true;
    const entry = packages.get(name);
    if (entry === undefined || seen.has(name)) return false;
    if (!reachesPostgres.has(name)) {
      seen.add(name);
      reachesPostgres.set(
        name,
        entry.dependencies.some((dependency) => reaches(dependency, seen)),
      );
    }
    return reachesPostgres.get(name);
  };
  const withoutPostgres = [...packages]
    .filter(([name]) => !reaches(name))
    .map(([, entry]) => `${entry.directory}/`);
  return (file) =>
    SOURCE_FILE.test(file) &&
    !file.startsWith('packages/database/migrations/') &&
    !/(?:^|\/)test\//u.test(file) &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file) &&
    !/fixture/u.test(file) &&
    !withoutPostgres.some((directory) => file.startsWith(directory));
}

export async function validateTransactionLocalSettings() {
  const inScope = scopeFilter();
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
    const found = unexemptedSessionSettings(file, source);
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
      `Session-level settings outlive their transaction on a pooled client. Make each one transaction-local (is_local true, SET LOCAL), or mark text that isn't SQL with a session-setting-exempt reason:\n${violations.join('\n')}`,
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
