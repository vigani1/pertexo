import ts from 'typescript';

const writeOperations = new Set([
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'mkdir',
  'mkdirSync',
  'mkdtemp',
  'mkdtempSync',
  'createWriteStream',
]);

/** Inspect destinations, not negative parser inputs or expected runtime paths. */
export function validateTestFileWrites(file, source) {
  if (!/^(?:apps|packages)\/[^/]+\/(?:test|e2e|e2e-live)\//u.test(file))
    return [];
  const bindings = new Map();
  const imports = new Map();
  const collect = (node) => {
    if (ts.isImportSpecifier(node))
      imports.set(node.name.text, node.propertyName?.text ?? node.name.text);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const values = bindings.get(node.name.text) ?? [];
      values.push(node.initializer);
      bindings.set(node.name.text, values);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const fixed = (node, seen = new Set()) => {
    if (!node) return false;
    if (ts.isStringLiteralLike(node))
      return /^\/(?:private\/)?tmp\//u.test(node.text);
    if (ts.isTemplateExpression(node))
      return (
        fixed(node.head, seen) ||
        node.templateSpans.some(({ expression }) => fixed(expression, seen))
      );
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      return (bindings.get(node.text) ?? []).some((value) =>
        fixed(value, new Set([...seen, node.text])),
      );
    }
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.PlusToken,
      ].includes(node.operatorToken.kind)
    )
      return fixed(node.left, seen) || fixed(node.right, seen);
    if (
      ts.isCallExpression(node) &&
      ['join', 'resolve'].includes(
        node.expression.getText(source).split('.').at(-1),
      )
    )
      return fixed(node.arguments[0], seen);
    return false;
  };
  const errors = [];
  const inspect = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      /^process\.env\.[A-Z0-9_]*(?:DIRECTORY|PATH|SOCKET)$/u.test(
        node.left.getText(source),
      ) &&
      fixed(node.right)
    )
      errors.push(
        `${file}: test-owned files use a created temporary directory and remove it after the test`,
      );
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(source).split('.').at(-1);
      const argument = node.arguments[0];
      const destination =
        name === 'screenshot' &&
        argument &&
        ts.isObjectLiteralExpression(argument)
          ? argument.properties.find(
              (property) =>
                ts.isPropertyAssignment(property) &&
                property.name.getText(source) === 'path',
            )?.initializer
          : writeOperations.has(imports.get(name) ?? name)
            ? argument
            : undefined;
      if (fixed(destination))
        errors.push(
          `${file}: test-owned files use a created temporary directory and remove it after the test`,
        );
    }
    ts.forEachChild(node, inspect);
  };
  inspect(source);
  return errors;
}
