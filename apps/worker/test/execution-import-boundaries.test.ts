import { readFile } from 'node:fs/promises';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function referencesProductionHandler(source: string): boolean {
  const sourceFile = ts.createSourceFile(
    'boundary.ts',
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  return sourceFile.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) &&
      !ts.isExportDeclaration(statement)
    )
      return false;
    const module = statement.moduleSpecifier;
    if (
      module === undefined ||
      !ts.isStringLiteralLike(module) ||
      module.text !== './node-attempt-handler.js'
    )
      return false;
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause === undefined) return true;
      if (clause.name?.text.includes('Capability') === true) return true;
      const bindings = clause.namedBindings;
      if (bindings === undefined) return false;
      if (ts.isNamespaceImport(bindings)) return true;
      return bindings.elements.some((element) =>
        (element.propertyName?.text ?? element.name.text).includes(
          'Capability',
        ),
      );
    }
    const clause = statement.exportClause;
    if (clause === undefined || ts.isNamespaceExport(clause)) return true;
    return clause.elements.some((element) =>
      (element.propertyName?.text ?? element.name.text).includes('Capability'),
    );
  });
}

describe('worker execution import boundaries', () => {
  it('keeps shared capability consumers independent of the production handler', async () => {
    const consumers = [
      'node-attempt-runtime.ts',
      'node-runtime-capabilities.ts',
      'preview-attempt-handler.ts',
      'provider-connection-runtime.ts',
    ];
    const sources = await Promise.all(
      consumers.map((file) =>
        readFile(path.resolve('src/execution', file), 'utf8'),
      ),
    );
    for (const source of sources)
      expect(referencesProductionHandler(source)).toBe(false);
  });

  it.each([
    `import type { Capability as RuntimeCapability } from "./node-attempt-handler.js";`,
    `import { type Capability } from './node-attempt-handler.js';`,
    `export { type Capability as RuntimeCapability } from "./node-attempt-handler.js";`,
    `export * from './node-attempt-handler.js';`,
  ])('detects alternate static boundary syntax %#', (source) => {
    expect(referencesProductionHandler(source)).toBe(true);
  });
});
