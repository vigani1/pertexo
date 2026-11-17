import { readFileSync } from 'node:fs';
import { SourceMap } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Maps positions in a built `dist` file back to its TypeScript source. The
// overlap workflow builds with `--sourceMap`; a built file without a map is a
// build mistake, and guessing lines would make every count wrong.

const SOURCE_MAP_COMMENT = /\/\/# sourceMappingURL=(\S+)\s*$/u;

/** Reads the map a built file names, or throws: lines can't be guessed. */
export function readSourceMap(builtFile) {
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
export function mapToSource({ mapFile, payload, map }, { line, column }) {
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
