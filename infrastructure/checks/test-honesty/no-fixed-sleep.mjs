import {
  lintedPath,
  ratchetMessages,
  ratchetSchema,
  reportRatchet,
} from './ratchet.mjs';
import {
  SLEEP_HELPER_EXPORTS,
  createSleepRecognizer,
  withoutExtension,
} from './sleeps.mjs';
import { enclosingFunction, isMember, isTestBody } from './test-syntax.mjs';

// After Landmines' no-fixed-sleep (https://github.com/interfere-inc/landmines, MIT).

const LOOPS = new Set([
  'WhileStatement',
  'DoWhileStatement',
  'ForStatement',
  'ForOfStatement',
  'ForInStatement',
]);

export const noFixedSleep = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a test, hook or test helper awaiting a fixed real-time delay.',
    },
    schema: [
      {
        type: 'object',
        properties: ratchetSchema,
        additionalProperties: false,
      },
    ],
    messages: {
      sleep:
        'Replace this fixed sleep with a signal: await the operation itself, an event it emits, or a promise its handler resolves (Promise.withResolvers). To move time, use fake timers and advance them. A sleep guesses how long real work takes: too short fails under load, too long only slows the suite.',
      helper:
        'This sleep helper is not listed in SLEEP_HELPER_EXPORTS (infrastructure/checks/test-honesty/sleeps.mjs), so its callers are not checked. List it there, or better, remove it.',
      unlisted:
        "SLEEP_HELPER_EXPORTS lists '{{name}}' from this file, but it no longer only sleeps. Remove the entry.",
      ...ratchetMessages('no-fixed-sleep', 'fixed sleeps'),
    },
  },
  create(context) {
    const file = lintedPath(context);
    const sleeps = createSleepRecognizer(file);
    const awaits = [];
    const calledNames = new Set();
    const exported = new Map();
    let fakeTimers = false;
    const onFunction = (node) => sleeps.onFunction(node);
    return {
      ImportDeclaration: (node) => sleeps.onImport(node),
      FunctionDeclaration: onFunction,
      FunctionExpression: onFunction,
      ArrowFunctionExpression: onFunction,
      AwaitExpression: (node) => awaits.push(node),
      CallExpression(node) {
        if (node.callee.type === 'Identifier')
          calledNames.add(node.callee.name);
        if (isMember(node.callee, 'vi', 'useFakeTimers')) fakeTimers = true;
      },
      ExportNamedDeclaration(node) {
        for (const [name, fn] of exportedFunctions(node))
          exported.set(name, fn);
      },
      'Program:exit'(program) {
        sleeps.resolveHelpers();
        reportHelperList(context, program, file, sleeps, exported);
        const violations = awaits.filter(
          (node) =>
            sleeps.isSleep(node.argument) &&
            !(fakeTimers && sleeps.isFakeable(node.argument)) &&
            drivenByTest(node, sleeps, calledNames, exported),
        );
        reportRatchet(context, program, violations, 'sleep');
      },
    };
  },
};

/**
 * Whether the test itself waits here, rather than a fake the code under test
 * calls. A delay inside a mock implementation, route handler, stream or fake
 * transport method simulates a slow outside service while the test awaits
 * the operation; a poll loop's pause only paces a condition it checks.
 */
function drivenByTest(node, sleeps, calledNames, exported) {
  const fn = enclosingFunction(node);
  for (let current = node.parent; current !== fn; current = current.parent)
    if (LOOPS.has(current.type)) return false;
  if (fn === null) return true;
  if (fn.generator || sleeps.isSleepHelper(fn)) return false;
  if (isTestBody(fn)) return true;
  const { parent } = fn;
  if (fn.type === 'FunctionDeclaration')
    return calledNames.has(fn.id?.name) || [...exported.values()].includes(fn);
  if (parent.type === 'VariableDeclarator')
    return (
      (parent.id.type === 'Identifier' && calledNames.has(parent.id.name)) ||
      [...exported.values()].includes(fn)
    );
  // `await act(async () => …)`: the test runs the callback and waits on it.
  // A method such as `page.route(…)` or `server.get(…)` registers a handler
  // the code under test calls later, so its callback is a fake.
  if (parent.type === 'CallExpression' && parent.arguments.includes(fn))
    return (
      parent.callee.type === 'Identifier' &&
      parent.parent?.type === 'AwaitExpression'
    );
  // A method of a fixture object the test calls, not of a fake handed to code.
  if (parent.type === 'Property' || parent.type === 'MethodDefinition')
    return !insideCallArguments(parent);
  return false;
}

function insideCallArguments(node) {
  for (let current = node; current.parent; current = current.parent) {
    const { parent } = current;
    if (
      (parent.type === 'CallExpression' || parent.type === 'NewExpression') &&
      parent.arguments.includes(current)
    )
      return true;
    if (parent.type === 'ClassBody') return true;
  }
  return false;
}

function exportedFunctions(node) {
  const { declaration } = node;
  if (declaration?.type === 'FunctionDeclaration' && declaration.id)
    return [[declaration.id.name, declaration]];
  if (declaration?.type !== 'VariableDeclaration') return [];
  return declaration.declarations
    .filter((item) => item.id.type === 'Identifier' && item.init)
    .map((item) => [item.id.name, item.init]);
}

/** Keeps SLEEP_HELPER_EXPORTS and the helpers support files export in step. */
function reportHelperList(context, program, file, sleeps, exported) {
  const listed = SLEEP_HELPER_EXPORTS.filter(
    (helper) => withoutExtension(helper.module) === withoutExtension(file),
  );
  for (const [name, fn] of exported)
    if (
      sleeps.isSleepHelper(fn) &&
      !listed.some((helper) => helper.name === name)
    )
      context.report({ node: fn, messageId: 'helper' });
  for (const helper of listed) {
    const fn = exported.get(helper.name);
    if (fn === undefined || !sleeps.isSleepHelper(fn))
      context.report({
        node: program,
        messageId: 'unlisted',
        data: { name: helper.name },
      });
  }
}
