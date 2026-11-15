import ts from 'typescript';

/**
 * Whether an import or export declaration loads its module when the code
 * runs. Under `verbatimModuleSyntax` only a declaration-level `type`
 * (`import type`, `export type`) is erased; `import { type A }` and
 * `export { type A } from` still load the module, as an empty import.
 */
export function loadsModule(statement) {
  if (ts.isImportDeclaration(statement))
    return statement.importClause?.isTypeOnly !== true;
  return !statement.isTypeOnly;
}
