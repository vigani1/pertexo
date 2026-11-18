import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The ratchet idea and its exact-count allowlist come from Landmines
// (https://github.com/interfere-inc/landmines, MIT): a file may keep the
// violations it had, never gain one, and its entry must drop as it improves.

export const repositoryRoot = fileURLToPath(
  new URL('../../../', import.meta.url),
);

/** Allowlist keys and lane globs are repository-relative POSIX paths. */
export function lintedPath(context) {
  const absolute = context.physicalFilename.replaceAll('\\', '/');
  const relative = path
    .relative(repositoryRoot, absolute)
    .replaceAll('\\', '/');
  return relative.startsWith('../') ? absolute : relative;
}

export const ratchetSchema = {
  allow: {
    type: 'object',
    additionalProperties: { type: 'integer', minimum: 1 },
  },
};

export function ratchetMessages(rule, noun) {
  return {
    stale: `This file now has {{count}} ${noun}; lower its entry in infrastructure/checks/test-honesty/${rule}.allow.json to {{count}} (remove it at 0).`,
  };
}

/**
 * Reports every violation when a file has more than its allowance, and one
 * stale finding when it has fewer, so the allowance only ever goes down.
 */
export function reportRatchet(context, program, violations, messageId) {
  const allowed = context.options[0]?.allow?.[lintedPath(context)] ?? 0;
  if (violations.length === allowed) return;
  if (violations.length < allowed) {
    context.report({
      node: program,
      messageId: 'stale',
      data: { count: String(violations.length) },
    });
    return;
  }
  // A violation is a node, or { node, messageId, data } when a rule words it.
  for (const violation of violations)
    context.report(
      violation.messageId === undefined
        ? { node: violation, messageId }
        : violation,
    );
}
