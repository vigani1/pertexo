import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { MIGRATIONS_DIRECTORY } from '../src/migrations.js';

/**
 * Some migrations change an existing function by reading its definition with
 * `pg_get_functiondef` and replacing a marker in the text. A marker that only
 * has to be present could match twice, or somewhere unintended, once later
 * migrations reshape the function. From 0123 on, every replacement must first
 * prove its marker occurs exactly once and raise otherwise. Earlier published
 * migrations are immutable history and keep their original presence checks.
 */
const FIRST_GUARDED_MIGRATION = 123;
/** Lines before a replacement in which its exactly-once guard must appear. */
const GUARD_WINDOW = 6;

/** Line numbers of text replacements that lack an exactly-once guard. */
function unguardedPatches(sql: string): readonly number[] {
  if (!sql.includes('pg_get_functiondef(')) return [];
  const lines = sql.split('\n');
  return lines.flatMap((line, index) => {
    if (!/(?:EXECUTE\s+|:=\s*)replace\(/iu.test(line)) return [];
    const guard = lines
      .slice(Math.max(0, index - GUARD_WINDOW), index)
      .join('\n');
    const counted = /length\(replace\(/iu.test(guard);
    const refused = /<>\s*1\s+THEN/iu.test(guard);
    return counted && refused ? [] : [index + 1];
  });
}

async function migration(name: string): Promise<string> {
  return readFile(path.join(MIGRATIONS_DIRECTORY, name), 'utf8');
}

describe('migrations that patch existing functions', () => {
  it('guard every text replacement from 0123 on', async () => {
    const names = (await readdir(MIGRATIONS_DIRECTORY)).filter(
      (name) =>
        /^\d{4}_[a-z0-9_]+\.sql$/u.test(name) &&
        Number(name.slice(0, 4)) >= FIRST_GUARDED_MIGRATION,
    );
    expect(names).toContain('0123_workspace_inbox_threads.sql');
    for (const name of names)
      expect(
        { name, unguarded: unguardedPatches(await migration(name)) },
        `${name} must check each replaced marker occurs exactly once`,
      ).toEqual({ name, unguarded: [] });
  });

  it('flags a presence-only patch and accepts the exactly-once guard', async () => {
    // 0120 predates the rule: it only checks that its marker is present.
    expect(
      unguardedPatches(await migration('0120_workspace_inbox_foundation.sql')),
    ).not.toEqual([]);
    const guarded = [
      "SELECT pg_get_functiondef('app.f()'::regprocedure) INTO v_definition;",
      "v_marker:='x';",
      "v_matches:=(length(v_definition)-length(replace(v_definition,v_marker,'')))/length(v_marker);",
      'IF v_matches<>1 THEN',
      "  RAISE EXCEPTION 'f shape is incompatible (% matches)',v_matches;",
      'END IF;',
      "EXECUTE replace(v_definition,v_marker,'y');",
    ].join('\n');
    expect(unguardedPatches(guarded)).toEqual([]);
  });
});
