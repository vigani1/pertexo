import { posix } from 'node:path';

const retired = new Map([
  [
    'features/workflows/components/workflow-name-field:WorkflowNameField',
    'WorkflowNameWithDialog from the same module',
  ],
  [
    'features/workflows/workflows-views.public:WorkflowNameField',
    'the workflow rename dialog',
  ],
  ['components/ui/deadline-field', 'components/patterns/dates/deadline-field'],
  [
    'features/catalog/components/timed-out-glyph',
    'components/patterns/dates/timed-out-glyph',
  ],
  [
    'components/patterns/settings/sentence',
    'the shared Field and Disclosure primitives',
  ],
  [
    'components/patterns/settings/section',
    'components/patterns/lists/rule-heading',
  ],
  ['components/patterns/settings/details', 'the Workflow Settings feature'],
  [
    'components/patterns/guidance/how-it-works',
    'the alert destination feature',
  ],
  ['components/patterns/dates/recent-days', 'the Workflow Runs feature'],
]);

export function webPath(filename) {
  return filename
    .replaceAll('\\', '/')
    .replace(/^.*\/apps\/web\//, '')
    .replace(/^apps\/web\//, '');
}

export function sourcePath(filename, specifier) {
  const path = specifier.startsWith('@/')
    ? `src/${specifier.slice(2)}`
    : specifier.startsWith('.')
      ? posix.join(posix.dirname(webPath(filename)), specifier)
      : specifier;
  return path
    .replace(/^src\//, '')
    .replace(/\.(?:[cm]?[jt]sx?)$/, '')
    .replace(/\/index$/, '');
}

export const currentOwner = (path) => retired.get(path);

export function sharedComponent(context, node) {
  const binding = node.type === 'JSXMemberExpression' ? node.object : node;
  if (
    binding.type !== 'JSXIdentifier' ||
    (node === binding && !/^[A-Z]/.test(binding.name))
  )
    return;
  const definition = definitionOf(context.sourceCode, binding);
  if (definition?.type !== 'ImportBinding') return;
  const path = sourcePath(context.filename, definition.parent.source.value);
  if (!/^components\/(?:ui|patterns)\//.test(path)) return;
  const name =
    node.type === 'JSXMemberExpression'
      ? node.property.name
      : (definition.node.imported?.name ?? binding.name);
  return { path, name };
}

function definitionOf(sourceCode, identifier) {
  let scope = sourceCode.getScope(identifier);
  while (scope && !scope.set.has(identifier.name)) scope = scope.upper;
  return scope?.set.get(identifier.name)?.defs[0];
}

// Read the value-producing branches without interpreting runtime conditions.
export function classStrings(node, sourceCode, visited = new Set()) {
  if (!node) return [];
  const read = (part) => classStrings(part, sourceCode, visited);
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string' ? [node.value] : [];
    case 'Identifier': {
      const definition = definitionOf(sourceCode, node);
      if (
        definition?.type !== 'Variable' ||
        definition.parent.kind !== 'const' ||
        visited.has(definition.node)
      )
        return [];
      visited.add(definition.node);
      return read(definition.node.init);
    }
    case 'TemplateLiteral':
      return [
        ...node.quasis.map((part) => part.value.cooked ?? part.value.raw),
        ...node.expressions.flatMap(read),
      ];
    case 'JSXExpressionContainer':
      return read(node.expression);
    case 'ConditionalExpression':
      return [...read(node.consequent), ...read(node.alternate)];
    case 'LogicalExpression':
      return node.operator === '&&'
        ? read(node.right)
        : [...read(node.left), ...read(node.right)];
    case 'CallExpression':
      return node.callee.type === 'Identifier' &&
        /^(?:cn|clsx|twMerge)$/.test(node.callee.name)
        ? node.arguments.flatMap(read)
        : [];
    case 'ArrayExpression':
      return node.elements.flatMap(read);
    case 'ObjectExpression':
      return node.properties.flatMap((property) => {
        if (property.type !== 'Property') return [];
        return !property.computed && property.key.type === 'Identifier'
          ? [property.key.name]
          : read(property.key);
      });
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
      return read(node.expression);
    default:
      return [];
  }
}
