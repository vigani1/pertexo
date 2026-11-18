import { ratchetMessages, ratchetSchema, reportRatchet } from './ratchet.mjs';
import { isFunction, isMember, propertyName } from './test-syntax.mjs';

// After Landmines' no-unsignaled-poll (https://github.com/interfere-inc/landmines, MIT).

const SPY_MATCHERS =
  /^(?:toHaveBeenCalled|toHaveBeenCalledOnce|toHaveBeenCalledTimes|toHaveBeenCalledWith|toHaveBeenCalledExactlyOnceWith|toHaveBeenLastCalledWith|toHaveBeenNthCalledWith|toHaveReturned|toHaveReturnedTimes|toHaveReturnedWith|toHaveLastReturnedWith|toHaveNthReturnedWith|toHaveResolved|toHaveResolvedTimes|toHaveResolvedWith|toHaveLastResolvedWith|toHaveNthResolvedWith|toBeCalled|toBeCalledTimes|toBeCalledWith)$/u;

export const noUnsignaledPoll = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow expect.poll and vi.waitFor on spy state or request recorders, which race a deadline instead of awaiting an event.',
    },
    schema: [
      {
        type: 'object',
        properties: ratchetSchema,
        additionalProperties: false,
      },
    ],
    messages: {
      poll: 'Await a signal instead of polling a spy or recorder: resolve a Promise.withResolvers() deferred where the call is recorded and await its promise, or await the operation that makes the call. A deadline-bound poll on a counter fails under load, and a longer timeout only hides that. Polling a real outcome (a stored row, text on screen) is fine.',
      ...ratchetMessages('no-unsignaled-poll', 'unsignaled polls'),
    },
  },
  create(context) {
    const violations = [];
    return {
      CallExpression(node) {
        const poll = isMember(node.callee, 'expect', 'poll');
        if (
          !poll &&
          !isMember(node.callee, 'vi', 'waitFor') &&
          !isMember(node.callee, 'vi', 'waitUntil')
        )
          return;
        const value = polledValue(node.arguments[0]);
        if (value === null) return;
        if (
          readsRecorder(value) ||
          (poll ? pollsLength(node, value) : assertsRecorder(value))
        )
          violations.push(node);
      },
      'Program:exit'(program) {
        reportRatchet(context, program, violations, 'poll');
      },
    };
  },
};

/** The one expression a callback polls; null when it does more than that. */
function polledValue(callback) {
  if (!isFunction(callback)) return null;
  if (callback.body.type !== 'BlockStatement') return callback.body;
  const [statement, ...rest] = callback.body.body;
  if (rest.length > 0 || statement === undefined) return null;
  if (statement.type === 'ReturnStatement') return statement.argument ?? null;
  return statement.type === 'ExpressionStatement' ? statement.expression : null;
}

/** `a.b.c` as names; null for anything that is not a plain property path. */
function memberPath(node) {
  if (node.type === 'ChainExpression') return memberPath(node.expression);
  if (node.type === 'Identifier') return [node.name];
  if (node.type !== 'MemberExpression') return null;
  const object = memberPath(node.object);
  return object && [...object, propertyName(node) ?? '[]'];
}

/** A spy's `.mock` state, or the size of a collection a fake records into. */
function readsRecorder(node) {
  const names = memberPath(node);
  if (names === null || names.includes('current')) return false;
  const last = names.at(-1);
  return (
    names.includes('mock') ||
    (names.length > 1 && (last === 'length' || last === 'size'))
  );
}

/** `expect(spy).toHaveBeenCalled…()` or `expect(recorded).toHaveLength(n)`. */
function assertsRecorder(node) {
  if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression')
    return false;
  const matcher = propertyName(node.callee) ?? '';
  const subject =
    node.callee.object.type === 'MemberExpression' &&
    propertyName(node.callee.object) === 'not'
      ? node.callee.object.object
      : node.callee.object;
  if (
    subject.type !== 'CallExpression' ||
    subject.callee.type !== 'Identifier' ||
    subject.callee.name !== 'expect'
  )
    return false;
  const [target] = subject.arguments;
  if (target === undefined || target.type === 'SpreadElement') return false;
  if (readsRecorder(target)) return true;
  const names = memberPath(target);
  return (
    names !== null &&
    !names.includes('current') &&
    (SPY_MATCHERS.test(matcher) || matcher === 'toHaveLength')
  );
}

/** `expect.poll(() => recorded).toHaveLength(n)`. */
function pollsLength(node, value) {
  const names = memberPath(value);
  return (
    node.parent.type === 'MemberExpression' &&
    propertyName(node.parent) === 'toHaveLength' &&
    names !== null &&
    !names.includes('current')
  );
}
