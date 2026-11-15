import process from 'node:process';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

import { STORAGE_INTEGRITY_ERRORS } from './core-repository-throws.mjs';
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
 * and throws (core's AGENTS.md): every domain throw in a core repository is a
 * finding.
 */
export function repositoryThrowFindings(throwsByFile) {
  return [...throwsByFile.values()]
    .flat()
    .map(
      (t) =>
        `${t.file}:${String(t.line)}: ${t.name} thrown in a repository. Return the row, boolean or nothing and throw in the operation, or list a storage integrity error in STORAGE_INTEGRITY_ERRORS with its reason.`,
    );
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
  report(
    repositoryThrowFindings(await collectRepositoryThrows()),
    'Core repositories throw only storage integrity errors.',
  );
}
