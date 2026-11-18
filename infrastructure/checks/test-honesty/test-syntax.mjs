// How Vitest, Playwright and node:test code looks in the syntax tree, shared
// by the test-honesty rules.

const TEST_CALLEES = new Set([
  'test',
  'it',
  'describe',
  'suite',
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
  'before',
  'after',
]);
export const HOOKS = new Set([
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
  'before',
  'after',
]);

export function propertyName(member) {
  if (member.type !== 'MemberExpression') return undefined;
  if (!member.computed && member.property.type === 'Identifier')
    return member.property.name;
  return member.property.type === 'Literal' &&
    typeof member.property.value === 'string'
    ? member.property.value
    : undefined;
}

export function isMember(node, object, property) {
  return (
    node.type === 'MemberExpression' &&
    node.object.type === 'Identifier' &&
    node.object.name === object &&
    propertyName(node) === property
  );
}

/** The identifier a call chain starts from: `it` for `it.each(rows)(...)`. */
export function calleeRoot(node) {
  if (node.type === 'CallExpression') return calleeRoot(node.callee);
  if (node.type === 'MemberExpression') return calleeRoot(node.object);
  if (node.type === 'TaggedTemplateExpression') return calleeRoot(node.tag);
  return node.type === 'Identifier' ? node.name : undefined;
}

/** The member names after the root: `['describe', 'configure']`. */
export function calleePath(node) {
  if (node.type === 'CallExpression') return calleePath(node.callee);
  if (node.type === 'TaggedTemplateExpression') return calleePath(node.tag);
  if (node.type !== 'MemberExpression') return [];
  return [...calleePath(node.object), propertyName(node) ?? '[]'];
}

export function isTestCall(call) {
  return (
    call.type === 'CallExpression' && TEST_CALLEES.has(calleeRoot(call.callee))
  );
}

export function isFunction(node) {
  return (
    node?.type === 'ArrowFunctionExpression' ||
    node?.type === 'FunctionExpression' ||
    node?.type === 'FunctionDeclaration'
  );
}

export function enclosingFunction(node) {
  let current = node.parent;
  while (current && !isFunction(current)) current = current.parent;
  return current ?? null;
}

/** A test, suite or hook body: a function passed straight to `it`, `test.step`, `beforeEach`… */
export function isTestBody(fn) {
  return (
    fn !== null &&
    fn.parent?.type === 'CallExpression' &&
    fn.parent.arguments.includes(fn) &&
    isTestCall(fn.parent)
  );
}

/** A numeric literal, also through `1_000`-style separators and `n * 1000`. */
export function numberValue(node) {
  if (node?.type === 'Literal' && typeof node.value === 'number')
    return node.value;
  if (node?.type === 'BinaryExpression' && node.operator === '*') {
    const left = numberValue(node.left);
    const right = numberValue(node.right);
    return left === undefined || right === undefined ? undefined : left * right;
  }
  return undefined;
}

export function objectProperty(object, name) {
  if (object?.type !== 'ObjectExpression') return undefined;
  return object.properties.find(
    (property) =>
      property.type === 'Property' &&
      !property.computed &&
      ((property.key.type === 'Identifier' && property.key.name === name) ||
        (property.key.type === 'Literal' && property.key.value === name)),
  );
}

/** Our own code: relative paths, workspace packages and the web `@/` alias. */
export function isInternalModule(source) {
  return (
    source.startsWith('./') ||
    source.startsWith('../') ||
    source.startsWith('@pertexo/') ||
    source.startsWith('@/')
  );
}
