import {
  isExecutionAreaFile,
  isExecutionAreaEntry,
} from './execution-area-rules.mjs';
import console from 'node:console';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '../..');
const codeExtension = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;
const words = '[a-z0-9]+(?:-[a-z0-9]+)*';
const basenamePattern = new RegExp(
  `^${words}(?:\\.${words})*\\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$`,
  'u',
);
const productionDirectory = new RegExp(`^${words}$`, 'u');
const testDirectory = new RegExp(`^${words}(?:\\.${words})*$`, 'u');
const reserved = new Set([
  'contract',
  'types',
  'store',
  'errors',
  'validation',
  'definition',
  'executor',
  'controller',
  'controllers',
  'module',
  'runtime',
  'service',
  'use-case',
  'use-cases',
  'utils',
  'helpers',
  'common',
]);
const vagueExecutionSubjects = new Set([
  'contract',
  'types',
  'utils',
  'helpers',
  'common',
  'misc',
  'data',
  'manager',
  'handler',
  'service',
  'shared',
  'base',
  'store',
  'input',
  'output',
  'commands',
  'errors',
  'runtime',
  'fixture',
  'fixtures',
  'support',
  'records',
  'reads',
  'state',
  'index',
]);
const excluded = new Set(['node_modules', 'dist', 'coverage', '.git']);
const roots = ['src', 'test', 'e2e', 'e2e-live'];

/** Validate a module's name and the two filename promises requiring syntax. */
export function validateFileName(file, text) {
  const diagnostics = [];
  const report = (rule, message) =>
    diagnostics.push({ path: file, rule, message });
  const segments = file.split('/');
  const production = segments[2] === 'src';
  const name = segments.at(-1);
  const stem = name.replace(codeExtension, '');
  if (!basenamePattern.test(name))
    report('FN001', 'Use lowercase kebab-case words separated by role dots.');
  const directoryPattern = production ? productionDirectory : testDirectory;
  for (const segment of segments.slice(3, -1))
    if (!directoryPattern.test(segment))
      report(
        'FN001',
        `Directory "${segment}" must use ${production ? 'kebab-case' : 'dot-separated kebab-case words'}.`,
      );
  if (isExecutionAreaFile(file)) {
    const subject = stem.split('.')[0];
    if (vagueExecutionSubjects.has(subject) && !isExecutionAreaEntry(file))
      report(
        'FN008',
        'Execution modules and fixtures name their concrete subject.',
      );
  }
  if (!production) return diagnostics;
  if (reserved.has(stem))
    report('FN002', 'Name the specific subject of this production module.');
  if (
    !file.startsWith('apps/web/') &&
    (stem === 'queries' || name.endsWith('.queries.ts'))
  )
    report(
      'FN003',
      'Backend database access uses a named repository or operation.',
    );
  if (file.startsWith('apps/web/src/features/')) {
    if (
      (segments.slice(5, -1).includes('data') &&
        ['api.ts', 'queries.ts'].includes(name)) ||
      ['queries.public', 'search.public'].includes(stem)
    )
      report(
        'FN004',
        'Name the feature transport, query or focused public subject.',
      );
  }
  if (['index.ts', 'index.tsx'].includes(name) || name.endsWith('.types.ts')) {
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    if (
      ['index.ts', 'index.tsx'].includes(name) &&
      !source.statements.every(isEntryStatement)
    )
      report(
        'FN005',
        'An index contains only bound imports, exports and empty statements.',
      );
    if (name.endsWith('.types.ts') && !source.statements.every(isTypeStatement))
      report(
        'FN006',
        'A types module contains only erased declarations and type-only imports/exports.',
      );
  }
  if (/\.(?:test|spec|cases)\.tsx?$/u.test(name))
    report(
      'FN007',
      'Keep discovered suites and case registrations outside production src.',
    );
  return diagnostics;
}

function isEntryStatement(statement) {
  return (
    ts.isEmptyStatement(statement) ||
    ts.isExportDeclaration(statement) ||
    (ts.isImportDeclaration(statement) &&
      hasImportBinding(statement.importClause))
  );
}

function hasImportBinding(clause) {
  if (clause === undefined) return false;
  if (clause.name !== undefined) return true;
  const bindings = clause.namedBindings;
  return (
    bindings !== undefined &&
    (ts.isNamespaceImport(bindings) || bindings.elements.length > 0)
  );
}

function isTypeStatement(statement) {
  if (
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement)
  )
    return true;
  if (ts.isImportEqualsDeclaration(statement)) return statement.isTypeOnly;
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    return (
      clause !== undefined &&
      (clause.isTypeOnly ||
        (clause.name === undefined &&
          clause.namedBindings !== undefined &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every(
            (specifier) => specifier.isTypeOnly,
          )))
    );
  }
  if (ts.isExportDeclaration(statement)) {
    if (statement.isTypeOnly) return true;
    if (
      statement.exportClause === undefined ||
      !ts.isNamedExports(statement.exportClause)
    )
      return false;
    return statement.exportClause.elements.length === 0
      ? statement.moduleSpecifier === undefined
      : statement.exportClause.elements.every(
          (specifier) => specifier.isTypeOnly,
        );
  }
  return false;
}

/** Inspect workspace code without loading it or following links into other trees. */
export async function inspectFileNames(directory = root) {
  const diagnostics = [];
  const entries = async (relative) => {
    try {
      const absolute = path.join(directory, relative);
      if (!(await lstat(absolute)).isDirectory()) return [];
      return await readdir(absolute, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  };
  const scan = async (relative) => {
    for (const entry of await entries(relative)) {
      if (entry.isSymbolicLink() || excluded.has(entry.name)) continue;
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await scan(file);
      else if (entry.isFile() && codeExtension.test(entry.name))
        diagnostics.push(
          ...validateFileName(
            file,
            await readFile(path.join(directory, file), 'utf8'),
          ),
        );
    }
  };
  for (const category of ['apps', 'packages'])
    for (const workspace of await entries(category))
      if (workspace.isDirectory())
        for (const tree of roots)
          await scan(`${category}/${workspace.name}/${tree}`);
  await scan('infrastructure');
  return diagnostics.sort((a, b) =>
    a.path < b.path
      ? -1
      : a.path > b.path
        ? 1
        : a.rule < b.rule
          ? -1
          : a.rule > b.rule
            ? 1
            : a.message.localeCompare(b.message, 'en'),
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const diagnostics = await inspectFileNames();
  if (diagnostics.length > 0) {
    for (const diagnostic of diagnostics)
      console.error(
        `${diagnostic.path}: ${diagnostic.rule}: ${diagnostic.message}`,
      );
    process.exitCode = 1;
  } else
    console.log('Workspace source and test filenames follow docs/naming.md.');
}
