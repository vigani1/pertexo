import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseOperatorCommandConfig } from '../src/config.js';

// The page's examples go through the CLI's own parser, so they can't drift from it.
// docs-deps-product-15: operators had no instructions for any mutating command.
const commandTypes = [
  ...readFileSync(
    new URL('../src/config.ts', import.meta.url),
    'utf8',
  ).matchAll(/OPERATOR_COMMAND_TYPE: z\.literal\('([^']+)'\)/gu),
].map((match) => match[1] ?? '');

const readPage = () =>
  readFileSync(
    new URL('../../../docs/operations/operator-commands.md', import.meta.url),
    'utf8',
  );

/** The text from a command's heading to the next heading of any command. */
function sectionFor(page: string, type: string) {
  const start = page.search(new RegExp(`^#{2,3} .*\`${type}\``, 'mu'));
  if (start < 0) return undefined;
  const rest = page.slice(start + 1);
  const end = rest.search(/^#{2,3} /mu);
  return end < 0 ? rest : rest.slice(0, end);
}

/** A stand-in for each placeholder an operator would fill in. */
function fill(name: string, value: string) {
  if (!/^<.*>$/u.test(value)) return value;
  if (name.endsWith('_TOKEN')) return '7';
  if (name.endsWith('_ID')) return randomUUID();
  if (name === 'OPERATOR_ACTOR_REF') return 'ops@example.test';
  if (name === 'OPERATOR_EVIDENCE_REF') return '{"ticket":"example"}';
  if (name === 'OPERATOR_RUN_INPUT') return '{"replayed":true}';
  return 'filled-in';
}

function exampleEnvironment(section: string) {
  const block = /```(?:sh|bash)\n([\s\S]*?)```/u.exec(section)?.[1] ?? '';
  const pairs = [...block.matchAll(/-e ([A-Z_]+)=('[^']*'|\S+)/gu)].map(
    (match) => {
      const name = match[1] ?? '';
      const value = (match[2] ?? '').replace(/^'|'$/gu, '');
      return [name, fill(name, value)] as const;
    },
  );
  return Object.fromEntries(pairs);
}

const platform = {
  DATABASE_MAINTENANCE_URL:
    'postgresql://pertexo_maintenance:example@postgres:5432/pertexo',
  NODE_ENV: 'production',
};

describe('the operator commands page', () => {
  it('knows every command the CLI accepts', () => {
    expect(commandTypes).toEqual(
      expect.arrayContaining([
        'operator.status',
        'attempt.reconcile',
        'run.cancel',
      ]),
    );
  });

  it.each(commandTypes)(
    '%s has a heading, says when to use it, and its example parses',
    (type) => {
      const section = sectionFor(readPage(), type);
      expect(section).toBeDefined();
      expect(section ?? '').toMatch(/\bwhen\b/iu);
      expect(section ?? '').toContain('run_ops');
      const environment = exampleEnvironment(section ?? '');
      expect(environment.OPERATOR_COMMAND_TYPE).toBe(type);
      const parsed = parseOperatorCommandConfig({
        ...platform,
        ...environment,
      });
      expect(parsed.command.type).toBe(type);
    },
  );

  it(
    'says how to find the fields an operator needs from the database',
    () => {
      const page = readPage();
      // attempt.reconcile needs an attempt ID and fence token; ops-03 had to get them from SQL.
      expect(page).toMatch(/OPERATOR_EXPECTED_FENCE_TOKEN/u);
      expect(page).toMatch(/operator\.status/u);
      expect(page).toMatch(/dry.?run/iu);
      expect(page).toMatch(/single-server\.md/u);
    },
  );
});
