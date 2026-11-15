import ts from 'typescript';

/*
 * Where HTTP code writes a status. The backend limits check lets a number
 * stand there, and the API's status check asks for Nest's `HttpStatus` there.
 */

const EQUALITIES = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);
const ORDERINGS = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);
// Statuses come in classes of a hundred: 2xx runs from 200 to 299.
const STATUS_CLASS_WIDTH = 100;
const LAST_IN_CLASS = STATUS_CLASS_WIDTH - 1;
const STATUS_BOUNDS = new Set(['min', 'max']);
const STATUS_NAME = /^(?:status|statusCode|httpStatus)$/u;
const FIRST_HTTP_STATUS = 100;
const LAST_HTTP_STATUS = 599;

/**
 * An HTTP status where HTTP code writes one: tested for equality against
 * something named `status`, `statusCode` or `httpStatus` (or ordered against a class
 * boundary such as 400 or 299), the value of such a property, a key of a route's
 * `responses`, or a status property's number schema. Naming 200 or 404 there
 * only adds noise; any other three-digit number is still a limit.
 */
export function isHttpStatus(node, value) {
  if (
    !Number.isInteger(value) ||
    value < FIRST_HTTP_STATUS ||
    value > LAST_HTTP_STATUS
  )
    return false;
  const parent = node.parent;
  if (ts.isBinaryExpression(parent)) {
    const other = parent.left === node ? parent.right : parent.left;
    if (EQUALITIES.has(parent.operatorToken.kind)) return isStatusName(other);
    if (ORDERINGS.has(parent.operatorToken.kind))
      return isClassBoundary(value) && isStatusName(other);
    return false;
  }
  if (ts.isPropertyAssignment(parent)) {
    if (parent.initializer === node) return isStatusName(parent.name);
    return parent.name === node && isResponsesObject(parent.parent);
  }
  return isArgumentOfStatusSchema(node);
}

// `status: z.literal(409)` or `status: z.number().int().min(400).max(599)`:
// the argument of a literal, min or max in a number schema that is a status
// property's value.
function isArgumentOfStatusSchema(node) {
  const call = node.parent;
  if (
    !ts.isCallExpression(call) ||
    !ts.isPropertyAccessExpression(call.expression)
  )
    return false;
  const method = call.expression.name.text;
  const isNumberSchema =
    method === 'literal'
      ? isZod(call.expression.expression)
      : STATUS_BOUNDS.has(method) && hasNumberRoot(call.expression.expression);
  if (!isNumberSchema) return false;
  let current = call;
  while (
    ts.isCallExpression(current.parent) ||
    ts.isPropertyAccessExpression(current.parent)
  )
    current = current.parent;
  const owner = current.parent;
  return (
    ts.isPropertyAssignment(owner) &&
    owner.initializer === current &&
    isStatusName(owner.name)
  );
}

function isClassBoundary(value) {
  const place = value % STATUS_CLASS_WIDTH;
  return place === 0 || place === LAST_IN_CLASS;
}

function isZod(node) {
  return ts.isIdentifier(node) && node.text === 'z';
}

// The chain below a bound starts with `z.number()`.
function hasNumberRoot(receiver) {
  let current = receiver;
  while (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression)
  ) {
    if (
      current.expression.name.text === 'number' &&
      isZod(current.expression.expression)
    )
      return true;
    current = current.expression.expression;
  }
  return false;
}

function isStatusName(node) {
  if (ts.isIdentifier(node)) return STATUS_NAME.test(node.text);
  if (ts.isPropertyAccessExpression(node))
    return STATUS_NAME.test(node.name.text);
  return false;
}

function isResponsesObject(object) {
  const owner = object.parent;
  return (
    ts.isObjectLiteralExpression(object) &&
    ts.isPropertyAssignment(owner) &&
    ts.isIdentifier(owner.name) &&
    owner.name.text === 'responses'
  );
}

/**
 * A status compared with a received number (`response.status === 404`,
 * `status >= 500`). Lint refuses comparing a number with an enum, so a
 * comparison writes the number while a status the code sends is `HttpStatus`.
 */
export function isStatusComparison(node) {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent))
    return (
      EQUALITIES.has(parent.operatorToken.kind) ||
      ORDERINGS.has(parent.operatorToken.kind)
    );
  return (
    ts.isCallExpression(parent) &&
    ts.isPropertyAccessExpression(parent.expression) &&
    STATUS_BOUNDS.has(parent.expression.name.text)
  );
}
