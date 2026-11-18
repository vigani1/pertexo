import { readFileSync } from 'node:fs';
import { SourceMap } from 'node:module';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Maps positions in a built `dist` file back to its TypeScript source. The
// overlap workflow builds with `--sourceMap`; a built file without a map is a
// build mistake, and guessing lines would make every count wrong.

const SOURCE_MAP_COMMENT = /\/\/# sourceMappingURL=(\S+)\s*$/u;
const SOURCE_DIRECTORY = /^(?:apps|packages)\/[^/]+\/src\//u;
const BUILT_DIRECTORY = /^(?:apps|packages)\/[^/]+\/dist\/.+\.js$/u;

/** Whether a file is a workspace's built JavaScript, which maps back to src. */
export function isBuiltFile(absolute, root) {
  return BUILT_DIRECTORY.test(relative(root, absolute));
}

/**
 * Collects `source file -> executed lines` from executed positions (1-based
 * line, 0-based column) in workspace `src` files or in built files, which
 * map back to `src` through their source maps. Everything else (tests,
 * tooling, dependencies) is left out.
 */
export function createReach(root) {
  const reached = new Map();
  const maps = new Map();
  const add = (file, line) => {
    const lines = reached.get(file) ?? new Set();
    reached.set(file, lines);
    lines.add(line);
  };
  return {
    add(absolute, positions) {
      const file = relative(root, absolute);
      if (SOURCE_DIRECTORY.test(file)) {
        for (const { line } of positions) add(file, line);
        return;
      }
      if (!BUILT_DIRECTORY.test(file) || positions.length === 0) return;
      const map = maps.get(absolute) ?? readSourceMap(absolute);
      maps.set(absolute, map);
      for (const position of positions) {
        const original = mapToSource(map, position);
        if (!original) continue;
        const source = relative(root, original.file);
        if (SOURCE_DIRECTORY.test(source)) add(source, original.line);
      }
    },
    lines() {
      return Object.fromEntries(
        [...reached.entries()]
          .sort(([a], [b]) => a.localeCompare(b, 'en'))
          .map(([file, lines]) => [file, [...lines].sort((a, b) => a - b)]),
      );
    },
  };
}

/** Reads the map a built file names, or throws: lines can't be guessed. */
function readSourceMap(builtFile) {
  const text = readFileSync(builtFile, 'utf8');
  const reference = SOURCE_MAP_COMMENT.exec(text)?.[1];
  if (!reference || reference.startsWith('data:'))
    throw new Error(
      `${builtFile} has no source map file; build with \`tsc --build --sourceMap\``,
    );
  const mapFile = resolve(dirname(builtFile), reference);
  const payload = JSON.parse(readFileSync(mapFile, 'utf8'));
  return { mapFile, payload, map: new SourceMap(payload) };
}

/**
 * The source file and 1-based line a generated position (Istanbul's: 1-based
 * line, 0-based column) came from, or null when that line has no mapping.
 */
function mapToSource({ mapFile, payload, map }, { line, column }) {
  const entry = map.findEntry(line - 1, column);
  // findEntry falls back to the nearest earlier mapping, even on another line.
  if (entry.originalSource === undefined || entry.generatedLine !== line - 1)
    return null;
  return {
    file: sourcePath(mapFile, payload.sourceRoot, entry.originalSource),
    line: entry.originalLine + 1,
  };
}

function sourcePath(mapFile, sourceRoot, source) {
  if (source.startsWith('file://')) return fileURLToPath(source);
  if (isAbsolute(source)) return source;
  return resolve(dirname(mapFile), sourceRoot ?? '', source);
}
