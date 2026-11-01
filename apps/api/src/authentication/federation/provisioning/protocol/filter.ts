import { parse, type Filter } from 'scim2-parse-filter';
import { DirectoryError, DIRECTORY_LIMITS } from '@pertexo/core/identity';

/** Budget the source before invoking the parser, then its linear AST before walking it. */
export function parseDirectoryFilter(source: string): Filter {
  assertFilterSource(source);
  try {
    const ast = parse(source),
      pending: { node: Filter; depth: number }[] = [{ node: ast, depth: 0 }];
    let nodes = 0;
    while (pending.length > 0) {
      const next = pending.pop();
      if (next === undefined) break;
      if (
        ++nodes > DIRECTORY_LIMITS.filterNodes ||
        next.depth > DIRECTORY_LIMITS.filterDepth
      )
        throw new DirectoryError('invalid_filter');
      const { node } = next;
      const children = filterChildren(node);
      pending.push(
        ...children.map((child) => ({ node: child, depth: next.depth + 1 })),
      );
    }
    return ast;
  } catch {
    throw new DirectoryError('invalid_filter');
  }
}

function assertFilterSource(source: string): void {
  if (source.length > DIRECTORY_LIMITS.filterCharacters)
    throw new DirectoryError('invalid_filter');
  let quoted = false,
    escaped = false,
    depth = 0;
  for (const character of source) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === '(' || character === '[') depth++;
    if (character === ')' || character === ']') depth--;
    if (depth > DIRECTORY_LIMITS.filterDepth || depth < 0)
      throw new DirectoryError('invalid_filter');
  }
  if (quoted || depth !== 0) throw new DirectoryError('invalid_filter');
}

function filterChildren(node: Filter): readonly Filter[] {
  switch (node.op) {
    case 'and':
    case 'or':
      return node.filters;
    case 'not':
      return [node.filter];
    case '[]':
      return [node.valFilter];
    case 'co':
    case 'eq':
    case 'ew':
    case 'ge':
    case 'gt':
    case 'le':
    case 'lt':
    case 'ne':
    case 'pr':
    case 'sw':
    default:
      return [];
  }
}
