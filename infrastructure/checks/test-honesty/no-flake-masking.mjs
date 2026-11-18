import path from 'node:path';

import {
  lintedPath,
  ratchetMessages,
  ratchetSchema,
  reportRatchet,
} from './ratchet.mjs';
import {
  HOOKS,
  calleePath,
  calleeRoot,
  isFunction,
  isMember,
  isTestCall,
  numberValue,
  objectProperty,
} from './test-syntax.mjs';

// After Landmines' no-flake-masking (https://github.com/interfere-inc/landmines, MIT).
// A per-test timeout is judged against its lane, so a product timeout under
// test or a lane that already allows the time is not flake masking.

const CONFIG_FILE = /(?:^|\/)(?:vitest|playwright)[^/]*\.config\.[cm]?[jt]s$/u;
const LANE_TIMEOUTS = new Set(['testTimeout', 'hookTimeout']);

export const noFlakeMasking = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow test retries and per-test timeouts above the lane, which hide flakes instead of fixing them.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          ...ratchetSchema,
          lanes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                files: { type: 'array', items: { type: 'string' } },
                testTimeout: { type: ['integer', 'null'] },
                hookTimeout: { type: ['integer', 'null'] },
              },
              required: ['files', 'testTimeout', 'hookTimeout'],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      retry:
        'Do not retry tests. A test that passes on a rerun is a flake: find what it races and await that event instead.',
      timeout:
        "Do not raise this timeout above the lane's {{limit}}. Await the event the test depends on, or move slow shared setup into a beforeAll. A test that truly needs longer belongs in a lane whose config says why.",
      slow: 'Do not mark a test slow; that triples its timeout. Await the event it depends on instead.',
      reason:
        'Say why this lane needs a longer timeout in a comment right above it.',
      ...ratchetMessages('no-flake-masking', 'retries or raised timeouts'),
    },
  },
  create(context) {
    const file = lintedPath(context);
    const lane = laneOf(file, context.options[0]?.lanes ?? []);
    const constants = new Map();
    const violations = [];
    const flag = (node, messageId, data) =>
      violations.push({ node, messageId, ...(data ? { data } : {}) });

    function checkTimeout(node, value, limit) {
      if (limit === null) return;
      const milliseconds = resolveNumber(value, constants);
      if (milliseconds === undefined || milliseconds > limit)
        flag(node, 'timeout', { limit: `${limit} ms` });
    }

    function checkRetries(options) {
      for (const name of ['retry', 'retries']) {
        const property = objectProperty(options, name);
        if (property && mayBePositive(property.value, constants))
          flag(property, 'retry');
      }
    }

    function checkTestCall(node) {
      // `it.each(rows)(name, fn, timeout)` is a test call like `it(…)`.
      const members =
        node.callee.type === 'CallExpression' ? [] : calleePath(node.callee);
      const hook = HOOKS.has(members.at(-1) ?? calleeRoot(node.callee));
      const limit = hook ? lane.hookTimeout : lane.testTimeout;
      if (members.includes('configure')) {
        const [options] = node.arguments;
        checkRetries(options);
        const timeout = objectProperty(options, 'timeout');
        if (timeout) checkTimeout(timeout, timeout.value, lane.testTimeout);
        return;
      }
      if (members.at(-1) === 'slow') return flag(node, 'slow');
      if (members.at(-1) === 'setTimeout')
        return checkTimeout(node, node.arguments[0], lane.testTimeout);
      if (
        ['each', 'for', 'extend', 'step', 'skip', 'todo'].includes(
          members.at(-1),
        )
      )
        return;
      for (const argument of node.arguments.slice(1)) {
        if (argument.type === 'ObjectExpression') {
          checkRetries(argument);
          const timeout = objectProperty(argument, 'timeout');
          if (timeout) checkTimeout(timeout, timeout.value, limit);
        }
      }
      // `it(name, fn, 60_000)` and `beforeAll(fn, 60_000)`.
      const timeout = node.arguments[hook ? 1 : 2];
      if (
        timeout !== undefined &&
        timeout.type !== 'ObjectExpression' &&
        !isFunction(timeout)
      )
        checkTimeout(timeout, timeout, limit);
    }

    return {
      VariableDeclarator(node) {
        if (node.id.type === 'Identifier' && node.parent.kind === 'const') {
          const value = numberValue(node.init);
          if (value !== undefined) constants.set(node.id.name, value);
        }
      },
      CallExpression(node) {
        if (isMember(node.callee, 'vi', 'setConfig')) {
          const [options] = node.arguments;
          const test = objectProperty(options, 'testTimeout');
          if (test) checkTimeout(test, test.value, lane.testTimeout);
          const hook = objectProperty(options, 'hookTimeout');
          if (hook) checkTimeout(hook, hook.value, lane.hookTimeout);
          checkRetries(options);
          return;
        }
        if (isTestCall(node)) checkTestCall(node);
      },
      Property(node) {
        if (node.computed) return;
        const name = node.key.name ?? node.key.value;
        const config = CONFIG_FILE.test(file);
        if (
          config &&
          (name === 'retry' || name === 'retries') &&
          mayBePositive(node.value, constants)
        )
          flag(node, 'retry');
        const laneTimeout =
          (LANE_TIMEOUTS.has(name) && !insideSetConfig(node)) ||
          (config && name === 'timeout' && isConfigRoot(node.parent));
        if (
          laneTimeout &&
          context.sourceCode.getCommentsBefore(node).length === 0
        )
          flag(node, 'reason');
      },
      'Program:exit'(program) {
        reportRatchet(context, program, violations, 'timeout');
      },
    };
  },
};

/** The last lane whose globs match the file; unknown files get Vitest's defaults. */
export function laneOf(file, lanes) {
  return (
    lanes.findLast((lane) =>
      lane.files.some((glob) => path.matchesGlob(file, glob)),
    ) ?? { testTimeout: 5_000, hookTimeout: 10_000 }
  );
}

function resolveNumber(node, constants) {
  if (node?.type === 'Identifier') return constants.get(node.name);
  return numberValue(node);
}

/** Whether a retry count may be above zero: `CI ? 2 : 0` may be. */
function mayBePositive(node, constants) {
  if (node.type === 'ConditionalExpression')
    return (
      mayBePositive(node.consequent, constants) ||
      mayBePositive(node.alternate, constants)
    );
  if (node.type === 'LogicalExpression')
    return (
      mayBePositive(node.left, constants) ||
      mayBePositive(node.right, constants)
    );
  const value = resolveNumber(node, constants);
  return value === undefined || value > 0;
}

/** The object a config file exports: `defineConfig({ timeout })`. */
function isConfigRoot(object) {
  const { parent } = object;
  return (
    (parent.type === 'CallExpression' && parent.arguments.includes(object)) ||
    parent.type === 'ExportDefaultDeclaration'
  );
}

function insideSetConfig(property) {
  const call = property.parent.parent;
  return (
    call?.type === 'CallExpression' && isMember(call.callee, 'vi', 'setConfig')
  );
}
