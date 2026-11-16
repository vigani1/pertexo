import path from 'node:path';
import ts from 'typescript';

/** Carry throwing declarations through static export chains, including aliases. */
export function followThrowingExports(texts, throwingByModule) {
  const forwards = [];
  for (const [file, text] of texts) {
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const imported = new Map();
    const targetOf = (specifier) =>
      ts.isStringLiteral(specifier) && specifier.text.startsWith('.')
        ? path.posix
            .join(path.posix.dirname(file), specifier.text)
            .replace(/\.js$/u, '.ts')
        : undefined;
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        statement.importClause?.isTypeOnly
      )
        continue;
      const target = targetOf(statement.moduleSpecifier);
      const clause = statement.importClause;
      if (clause?.name)
        imported.set(clause.name.text, { target, name: 'default' });
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements)
          if (!element.isTypeOnly)
            imported.set(element.name.text, {
              target,
              name: (element.propertyName ?? element.name).text,
            });
    }
    for (const statement of source.statements) {
      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
        const clause = statement.exportClause;
        if (statement.moduleSpecifier !== undefined) {
          const target = targetOf(statement.moduleSpecifier);
          if (clause && ts.isNamedExports(clause)) {
            for (const element of clause.elements)
              if (!element.isTypeOnly)
                forwards.push({
                  file,
                  target,
                  name: (element.propertyName ?? element.name).text,
                  exported: element.name.text,
                });
          } else
            forwards.push({
              file,
              target,
              name: '*',
              exported: clause?.name.text,
            });
        } else if (clause && ts.isNamedExports(clause)) {
          for (const element of clause.elements)
            if (!element.isTypeOnly) {
              const name = (element.propertyName ?? element.name).text;
              forwards.push({
                file,
                ...(imported.get(name) ?? { target: file, name }),
                exported: element.name.text,
              });
            }
        }
      } else if (ts.isExportAssignment(statement)) {
        const binding = ts.isIdentifier(statement.expression)
          ? imported.get(statement.expression.text)
          : undefined;
        if (binding) forwards.push({ file, ...binding, exported: 'default' });
        else if (ts.isIdentifier(statement.expression))
          forwards.push({
            file,
            target: file,
            name: statement.expression.text,
            exported: 'default',
          });
        else throwingByModule.get(file)?.add('*');
      }
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const { file, target, name, exported } of forwards) {
      const source = throwingByModule.get(target);
      const names = throwingByModule.get(file);
      if (names === undefined) continue;
      // An external or otherwise unindexed re-export cannot certify a declaration.
      const forwarded =
        source === undefined || source.has('*')
          ? ['*']
          : name === '*'
            ? exported === undefined
              ? [...source].filter((value) => value !== 'default')
              : source.size > 0
                ? [exported]
                : []
            : source.has(name)
              ? [exported]
              : [];
      for (const value of forwarded)
        if (!names.has(value)) {
          names.add(value);
          changed = true;
        }
    }
  }
}
