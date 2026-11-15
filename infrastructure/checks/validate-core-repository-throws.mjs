import console from 'node:console';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

import {
  REPOSITORY_THROW_BACKLOG,
  STORAGE_INTEGRITY_ERRORS,
} from './core-repository-throws.mjs';
import {
  listSourceFiles,
  readSource,
  report,
  repositoryRoot,
} from './workspace-sources.mjs';

const REPOSITORY = /^packages\/core\/src\/.+\.repository\.ts$/u;

/**
 * The throws in a core repository that aren't storage integrity assertions:
 * `throw new X(…)` for any X that isn't `Error` or a listed integrity error,
 * and `throw` of a call (`throw conflict()`), whose error the check can't
 * name. Rethrowing a caught value (`throw error`) is not counted.
 */
export function findDomainThrows(file, text) {
  if (!REPOSITORY.test(file)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (ts.isThrowStatement(node) && node.expression !== undefined) {
      const thrown = node.expression;
      const name = ts.isNewExpression(thrown)
        ? thrown.expression.getText(source)
        : ts.isCallExpression(thrown)
          ? `${thrown.expression.getText(source)}()`
          : undefined;
      if (
        name !== undefined &&
        name !== 'Error' &&
        !Object.hasOwn(STORAGE_INTEGRITY_ERRORS, name)
      ) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        found.push({ file, line: line + 1, name });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * A repository returns a row, a boolean or nothing, and the operation decides
 * and throws (core's AGENTS.md). Files that still throw domain errors are
 * listed with their count in REPOSITORY_THROW_BACKLOG, which only shrinks: a
 * new file, a growing count and a count that fell without the list following
 * are all refused.
 */
export function repositoryThrowFindings(
  throwsByFile,
  backlog = REPOSITORY_THROW_BACKLOG,
) {
  const findings = [];
  for (const [file, throws] of throwsByFile) {
    const allowed = backlog[file] ?? 0;
    if (throws.length > allowed)
      findings.push(
        `${file}: ${String(throws.length)} domain throw(s) in a repository, ${String(allowed)} allowed. Return the row, boolean or nothing and throw in the operation (${throws.map((t) => `${t.name} at line ${String(t.line)}`).join(', ')}).`,
      );
    else if (throws.length < allowed)
      findings.push(
        `${file}: REPOSITORY_THROW_BACKLOG allows ${String(allowed)} domain throw(s), and the file has ${String(throws.length)}; lower its entry${throws.length === 0 ? ' (remove it)' : ''}.`,
      );
  }
  for (const file of Object.keys(backlog))
    if (!throwsByFile.has(file))
      findings.push(
        `REPOSITORY_THROW_BACKLOG lists ${file}, which is no longer a core repository; remove it.`,
      );
  return findings;
}

export async function collectRepositoryThrows(root = repositoryRoot) {
  const throwsByFile = new Map();
  for (const file of await listSourceFiles('packages/core', root))
    if (REPOSITORY.test(file))
      throwsByFile.set(
        file,
        findDomainThrows(file, await readSource(file, root)),
      );
  return throwsByFile;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const throwsByFile = await collectRepositoryThrows();
  if (process.argv.includes('--backlog')) {
    for (const [file, throws] of [...throwsByFile].sort())
      if (throws.length > 0)
        console.log(`  '${file}': ${String(throws.length)},`);
  } else
    report(
      repositoryThrowFindings(throwsByFile),
      'Core repositories throw only storage integrity errors, beyond the shrinking backlog.',
    );
}
