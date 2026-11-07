import path from 'node:path';

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
  if (
    !/^(?:(?:apps|packages)\/[^/]+\/(?:test|e2e|e2e-live)\/|infrastructure\/.*(?:\/test\/|\.test\.))/u.test(
      file,
    )
  )
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
  const literal = (expression, seen = new Set()) => {
    const node = unwrap(expression);
    if (!node) return undefined;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      const values = bindings.get(node.text);
      if (values?.length === 1)
        return literal(values[0], new Set([...seen, node.text]));
    }
    if (ts.isCallExpression(node)) {
      const operation = pathOperation(node, source, imports);
      if (operation === undefined) return undefined;
      const parts = node.arguments.map((argument) => literal(argument, seen));
      if (parts.some((part) => part === undefined)) return undefined;
      // A relative resolve depends on the process cwd, which isn't a literal.
      if (operation === 'resolve' && !parts.some(path.posix.isAbsolute))
        return undefined;
      return path.posix[operation](...parts);
    }
    return undefined;
  };
  const fixed = (expression, seen = new Set()) => {
    const node = unwrap(expression);
    if (!node) return false;
    const destination = literal(node, seen);
    if (destination !== undefined)
      return /^\/(?:private\/)?tmp(?:\/|$)/u.test(destination);
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
      pathOperation(node, source, imports) !== undefined
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

function unwrap(node) {
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isTypeAssertionExpression(node))
  )
    node = node.expression;
  return node;
}

function pathOperation(node, source, imports) {
  const name = unwrap(node.expression).getText(source).split('.').at(-1);
  const operation = imports.get(name) ?? name;
  return ['join', 'resolve'].includes(operation) ? operation : undefined;
}
