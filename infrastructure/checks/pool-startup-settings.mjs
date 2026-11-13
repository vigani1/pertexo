import ts from 'typescript';

// A connection's startup settings (pg's `options`, libpq's -c, PGOPTIONS, a
// connection string's options parameter) hold for the whole session, so
// every transaction a pooled client ever runs inherits them. Only settings
// named here may be sent that way.

/** Startup settings a pool may send, each with the reason it carries no tenant context. */
const ALLOWED_STARTUP_SETTINGS = Object.freeze({
  statement_timeout:
    'a per-pool deadline the same for every user of the pool; the pools set it through pg config',
});

// -c name=value or -cname=value, also URL-encoded, anywhere.
const DASH_C_SETTING =
  /(?:^|[\s'"=&?+]|%20)-c(?:\s*|\+|%20)([A-Za-z_][\w.]*)\s*(?:=|%3D)/giu;
// --name=value too, where the text is startup options: a pool's options, a
// connection string's options parameter, or PGOPTIONS. Elsewhere it is an
// ordinary command-line flag.
const ANY_SETTING =
  /(?:^|[\s'"=&?+]|%20)(?:-c(?:\s*|\+|%20)|--)([A-Za-z_][\w.]*)\s*(?:=|%3D)/giu;
const OPTIONS_TEXT = /(?:^|[?&\s])options=|PGOPTIONS=/u;

/** Startup settings the node sends that aren't allowed, as findings. */
export function startupSettingFindings(node) {
  const literal = literalValue(node);
  if (literal !== undefined)
    return disallowedSettings(
      literal,
      isStartupOptionsValue(node) || OPTIONS_TEXT.test(literal)
        ? ANY_SETTING
        : DASH_C_SETTING,
    );
  if (isPoolOptionsProperty(node)) {
    const value = node.initializer ?? node.name;
    // A literal value is read where the literal itself is visited.
    if (literalValue(value) === undefined)
      return [`options: ${value.getText()} (startup settings can't be read)`];
  }
  if (isOptionsSearchParameter(node)) {
    const value = node.arguments[1];
    if (literalValue(value) === undefined)
      return [`${node.getText()} (startup settings can't be read)`];
  }
  return [];
}

function disallowedSettings(text, pattern) {
  return [...text.matchAll(pattern)]
    .map((match) => match[1])
    .filter((name) => !Object.hasOwn(ALLOWED_STARTUP_SETTINGS, name))
    .map((name) => `startup setting ${name}`);
}

function literalValue(node) {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isTemplateExpression(node))
    return [
      node.head.text,
      ...node.templateSpans.map((span) => span.literal.text),
    ].join('?');
  return undefined;
}

/** The literal is the value of a pool's options or of a connection string's options parameter. */
function isStartupOptionsValue(node) {
  const parent = node.parent;
  return (
    (isPoolOptionsProperty(parent) && parent.initializer === node) ||
    (isOptionsSearchParameter(parent) && parent.arguments[1] === node)
  );
}

/** `options` in an object given to new Pool / new Client, or one holding a connectionString. */
function isPoolOptionsProperty(node) {
  if (!(
    ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)
  ))
    return false;
  if (propertyName(node) !== 'options') return false;
  const object = node.parent;
  if (!ts.isObjectLiteralExpression(object)) return false;
  const constructed =
    ts.isNewExpression(object.parent) &&
    ['Pool', 'Client'].includes(object.parent.expression.getText());
  const connection = object.properties.some(
    (property) => propertyName(property) === 'connectionString',
  );
  return constructed || connection;
}

/** `<url>.searchParams.set('options', value)`: a connection string's startup settings. */
function isOptionsSearchParameter(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    /^(?:set|append)$/u.test(node.expression.name.text) &&
    /searchParams$/u.test(node.expression.expression.getText()) &&
    node.arguments[0] !== undefined &&
    literalValue(node.arguments[0]) === 'options'
  );
}

function propertyName(property) {
  const name = property.name;
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}
