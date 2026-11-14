import { parse } from 'acorn';
import { CODE_LIMITS, type CodeLanguage } from './code-settings.js';
import { formatByteSize } from '../values/byte-size.js';

export type CodeSyntaxIssue = Readonly<{
  message: string;
  line: number;
  column: number;
}>;
// acorn parses code steps as this language edition.
const ECMASCRIPT_EDITION = 2025;
// The wrapper puts the step's first line on line 3.
const WRAPPER_LINES = 2;
const prefix =
  'async function pertexoCode(input, $vars, require, console) {\n"use strict";\n';
/** Parse an async body without evaluating it, in the browser and at publication. */
export function inspectCodeSource(
  source: string,
  language: CodeLanguage = 'javascript',
): CodeSyntaxIssue | undefined {
  if (!source.trim())
    return {
      message: `Enter ${language === 'python' ? 'Python' : 'JavaScript'} that returns a JSON value.`,
      line: 1,
      column: 1,
    };
  if (new TextEncoder().encode(source).byteLength > CODE_LIMITS.sourceBytes)
    return {
      message: `Code is limited to ${formatByteSize(CODE_LIMITS.sourceBytes)}. Shorten this step.`,
      line: 1,
      column: 1,
    };
  if (language === 'python') return undefined;
  try {
    const parsed = parse(prefix + source + '\n}', {
      ecmaVersion: ECMASCRIPT_EDITION,
      sourceType: 'script',
      locations: true,
    });
    if (parsed.body.length !== 1)
      return {
        message: 'Enter an async function body, without an enclosing function.',
        line: 1,
        column: 1,
      };
    return undefined;
  } catch (error: unknown) {
    const located = error as SyntaxError & {
      loc?: { line: number; column: number };
    };
    return {
      message: located.message
        .replace(/\s\(\d+:\d+\)$/u, '')
        .slice(0, CODE_LIMITS.messageCharacters),
      line: Math.max(
        1,
        (located.loc?.line ?? WRAPPER_LINES + 1) - WRAPPER_LINES,
      ),
      column: (located.loc?.column ?? 0) + 1,
    };
  }
}
