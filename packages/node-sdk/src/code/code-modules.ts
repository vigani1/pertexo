import { z } from 'zod';

export const CODE_ALLOWED_BUILTINS = Object.freeze([
  'assert',
  'buffer',
  'crypto',
  'events',
  'path',
  'querystring',
  'string_decoder',
  'url',
  'util',
  'zlib',
]);
export const CODE_DEFAULT_PACKAGES = Object.freeze(['lodash', 'dayjs']);
export const codeLanguageSchema = z.enum(['javascript', 'python']);
export type CodeLanguage = z.output<typeof codeLanguageSchema>;
export const CODE_PYTHON_MODULES = Object.freeze([
  'json',
  'math',
  'statistics',
  'datetime',
  // datetime's C methods import these through the caller's import hook.
  'time',
  '_strptime',
  'zoneinfo',
  're',
  'decimal',
  'fractions',
  'itertools',
  'functools',
  'collections',
  'string',
  'textwrap',
  'hashlib',
  'hmac',
  'base64',
  'uuid',
  'random',
  'urllib.parse',
  'html',
  'csv',
  'io',
]);
