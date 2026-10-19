import { parseJsonPath } from '@pertexo/workflow-model';
import type { FieldParseResult } from './draft';

const MAX_PATH_BYTES = 512;
const MAX_PATH_SEGMENTS = 64;
const PATH_EXAMPLE = 'Write a field like email, or a path like items[0].id.';

/**
 * Reads a field people type the way n8n and Zapier take it (`email`,
 * `order.total`, `first name`) and stores the platform path (`$.email`,
 * `$.order.total`, `$['first name']`). Text that already starts with `$`
 * is kept as written.
 */
export function parseItemPath(text: string): FieldParseResult<string> {
  const typed = text.trim();
  if (typed === '') return { ok: false, error: PATH_EXAMPLE };
  const path = asPath(typed);
  const segments = path === undefined ? undefined : parseJsonPath(path);
  if (path === undefined || segments === undefined)
    return { ok: false, error: PATH_EXAMPLE };
  if (
    new TextEncoder().encode(path).byteLength > MAX_PATH_BYTES ||
    segments.length > MAX_PATH_SEGMENTS
  )
    return {
      ok: false,
      error: `Paths can be at most ${String(MAX_PATH_BYTES)} bytes and ${String(MAX_PATH_SEGMENTS)} levels deep.`,
    };
  return { ok: true, value: path };
}

function asPath(typed: string): string | undefined {
  if (typed.startsWith('$')) return typed;
  if (typed.startsWith('[')) return `$${typed}`;
  const dotted = `$.${typed}`;
  if (parseJsonPath(dotted) !== undefined) return dotted;
  // One name the dotted form can't spell, such as `first name`.
  if (/[.[\]]/u.test(typed)) return undefined;
  return `$['${typed.replace(/['\\]/gu, '\\$&')}']`;
}
