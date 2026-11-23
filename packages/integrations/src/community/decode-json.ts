import { CommunityManifestError } from './manifest.errors.js';
import { COMMUNITY_MANIFEST_LIMITS as limits } from './manifest-limits.js';

const JSON_TOKEN =
  // oxlint-disable-next-line eslint/no-control-regex -- JSON forbids unescaped control characters.
  /[ \t\r\n]*(?:"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[[\]{}:,])/uy;
const JSON_WHITESPACE = /^[ \t\r\n]*$/u;

export function decodeCommunityJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength > limits.bytes)
    throw new CommunityManifestError('file exceeds its byte limit');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (cause) {
    throw new CommunityManifestError('file is not UTF-8', { cause });
  }
  return parseJson(text);
}

function parseJson(text: string): unknown {
  const tokenPattern = new RegExp(JSON_TOKEN);
  let offset = 0;
  let values = 0;
  const parsed = value(0);
  if (!JSON_WHITESPACE.test(text.slice(offset))) invalid();
  return parsed;

  function next(): string {
    tokenPattern.lastIndex = offset;
    const match = tokenPattern.exec(text);
    if (match === null) return invalid();
    offset = tokenPattern.lastIndex;
    return match[0].trimStart();
  }

  function value(depth: number): unknown {
    if (depth > limits.depth || ++values > limits.values)
      throw new CommunityManifestError('JSON exceeds its depth or value limit');
    const token = next();
    if (token === '{') return object(depth + 1);
    if (token === '[') return array(depth + 1);
    if (token.startsWith('"')) return string(token);
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    const numeric = Number(token);
    return Number.isFinite(numeric) ? numeric : invalid();
  }

  function object(depth: number): Record<string, unknown> {
    const result = Object.create(null) as Record<string, unknown>;
    let token = next();
    if (token === '}') return result;
    for (;;) {
      if (!token.startsWith('"')) invalid();
      const key = string(token);
      if (Object.hasOwn(result, key))
        throw new CommunityManifestError(
          `duplicate JSON key ${JSON.stringify(key)}`,
        );
      if (next() !== ':') invalid();
      result[key] = value(depth);
      token = next();
      if (token === '}') return result;
      if (token !== ',') invalid();
      token = next();
    }
  }

  function array(depth: number): unknown[] {
    const result: unknown[] = [];
    const start = offset;
    if (next() === ']') return result;
    offset = start;
    for (;;) {
      result.push(value(depth));
      const token = next();
      if (token === ']') return result;
      if (token !== ',') invalid();
    }
  }

  function invalid(): never {
    throw new CommunityManifestError(
      `invalid JSON near character ${offset.toString()}`,
    );
  }
}

function string(token: string): string {
  const result = JSON.parse(token) as string;
  if (result.length > limits.stringCharacters || !result.isWellFormed())
    throw new CommunityManifestError(
      'JSON string exceeds its limit or is malformed',
    );
  return result;
}
