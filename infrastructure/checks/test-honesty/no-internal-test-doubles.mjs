import { ratchetMessages, ratchetSchema, reportRatchet } from './ratchet.mjs';
import { isInternalModule, isMember, propertyName } from './test-syntax.mjs';

// After Landmines' no-test-doubles (https://github.com/interfere-inc/landmines,
// MIT), narrowed to AGENTS.md's "mock only outside services": fakes of HTTP,
// SMTP, S3, Redis and the clock stay allowed, and so does a plain vi.fn().

const MOCKING =
  /^mock(?:Implementation|ReturnValue|ResolvedValue|RejectedValue)(?:Once)?$/u;

// Globals that are the seam to an outside service or to time. A test fakes
// the network or the clock through them; any other global is our own code
// or the platform, which the test should run for real.
const OUTSIDE_SERVICE_GLOBALS = new Set([
  'fetch',
  'WebSocket',
  'EventSource',
  'XMLHttpRequest',
  'Date',
  'performance',
]);

export const noInternalTestDoubles = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow replacing our own modules, objects or globals in tests; fake only outside services.',
    },
    schema: [
      {
        type: 'object',
        properties: ratchetSchema,
        additionalProperties: false,
      },
    ],
    messages: {
      module:
        'Do not mock our own module ({{source}}); run the real code. Fake only the outside service at its seam (HTTP, SMTP, S3, Redis transport, the clock), or pass a dependency in.',
      spy: 'Do not replace our own code with a spy implementation; run the real code. A spy that only observes (no mock*) is fine, and an outside service is faked at its seam.',
      global:
        "Do not stub the global '{{name}}'; only the network and the clock ({{allowed}}) are seams to fake. Use the real implementation, such as one imported from a node: module.",
      ...ratchetMessages('no-internal-test-doubles', 'internal test doubles'),
    },
  },
  create(context) {
    const internal = new Set();
    const platform = new Set();
    const violations = [];
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        for (const specifier of node.specifiers) {
          if (isInternalModule(source)) internal.add(specifier.local.name);
          if (source.startsWith('node:')) platform.add(specifier.local.name);
        }
      },
      CallExpression(node) {
        const { callee } = node;
        if (
          (isMember(callee, 'vi', 'mock') ||
            isMember(callee, 'vi', 'doMock')) &&
          node.arguments[0]?.type === 'Literal' &&
          typeof node.arguments[0].value === 'string' &&
          isInternalModule(node.arguments[0].value)
        )
          violations.push({
            node,
            messageId: 'module',
            data: { source: node.arguments[0].value },
          });
        if (isMember(callee, 'vi', 'stubGlobal')) {
          const [name, value] = node.arguments;
          const global =
            name?.type === 'Literal' && typeof name.value === 'string'
              ? name.value
              : undefined;
          if (
            !OUTSIDE_SERVICE_GLOBALS.has(global) &&
            !realPlatform(value, platform)
          )
            violations.push({
              node,
              messageId: 'global',
              data: {
                name: global ?? 'a computed name',
                allowed: [...OUTSIDE_SERVICE_GLOBALS].join(', '),
              },
            });
        }
        if (
          callee.type === 'MemberExpression' &&
          MOCKING.test(propertyName(callee) ?? '') &&
          spiesOnInternal(callee.object, internal)
        )
          violations.push({ node, messageId: 'spy' });
      },
      'Program:exit'(program) {
        reportRatchet(context, program, violations, 'module');
      },
    };
  },
};

/** `vi.spyOn(<something imported from our code>, …)`, possibly through `.prototype`. */
function spiesOnInternal(node, internal) {
  if (node.type !== 'CallExpression' || !isMember(node.callee, 'vi', 'spyOn'))
    return false;
  let target = node.arguments[0];
  while (target?.type === 'MemberExpression') target = target.object;
  return target?.type === 'Identifier' && internal.has(target.name);
}

/** `vi.stubGlobal('crypto', webcrypto)` installs the real thing, not a fake. */
function realPlatform(value, platform) {
  let root = value;
  while (root?.type === 'MemberExpression') root = root.object;
  return root?.type === 'Identifier' && platform.has(root.name);
}
