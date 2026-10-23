import { defineUtility } from './registration.js';
import {
  textConfigSchema,
  textInputSchema,
  textOutputSchema,
} from './text/validation.js';
import {
  numberConfigSchema,
  numberInputSchema,
  numberOutputSchema,
} from './number/validation.js';
import {
  cryptoConfigSchema,
  cryptoInputSchema,
  cryptoOutputSchema,
} from './crypto/validation.js';
import {
  hmacConfigSchema,
  hmacInputSchema,
  hmacOutputSchema,
} from './hmac/validation.js';
import {
  xmlConfigSchema,
  xmlInputSchema,
  xmlOutputSchema,
} from './xml/validation.js';
import {
  htmlConfigSchema,
  htmlInputSchema,
  htmlOutputSchema,
} from './html/validation.js';

export const UTILITY_DEFINITIONS = Object.freeze([
  defineUtility({
    key: 'core.text',
    configSchema: textConfigSchema,
    inputSchema: textInputSchema,
    outputSchema: textOutputSchema,
    semantics: [
      'Exact mapped Unicode text; explicit en-US casing; replace and split use literal strings, never regular expressions. Truncation counts code points and includes any ellipsis in its limit.',
    ],
  }),
  defineUtility({
    key: 'core.number',
    configSchema: numberConfigSchema,
    inputSchema: numberInputSchema,
    outputSchema: numberOutputSchema,
    semantics: [
      'Format finite numbers using an explicit Intl locale; decimal, percentage or currency. No implicit parsing or exchange rates.',
    ],
  }),
  defineUtility({
    key: 'core.crypto',
    configSchema: cryptoConfigSchema,
    inputSchema: cryptoInputSchema,
    outputSchema: cryptoOutputSchema,
    semantics: [
      'Hash exact UTF-8 bytes. MD5 is not for security. UUID and random IDs use the cryptographic system RNG; re-execution produces a new value.',
    ],
  }),
  defineUtility({
    key: 'core.hmac',
    configSchema: hmacConfigSchema,
    inputSchema: hmacInputSchema,
    outputSchema: hmacOutputSchema,
    semantics: [
      'Sign exact mapped UTF-8 bytes with SHA-256 or SHA-512 and a workspace-bound encrypted Signing key connection. No key in config, inputs or output.',
    ],
    connectionSlot: 'hmac_key',
  }),
  defineUtility({
    key: 'core.xml',
    configSchema: xmlConfigSchema,
    inputSchema: xmlInputSchema,
    outputSchema: xmlOutputSchema,
    semantics: [
      'XML data conversion preserves strings, namespace prefixes, @_ attributes, #text and repeated sibling arrays. No DTD, external entities or processing instructions. At most 48 nested tags and 8000 elements/attributes.',
    ],
  }),
  defineUtility({
    key: 'core.html',
    configSchema: htmlConfigSchema,
    inputSchema: htmlInputSchema,
    outputSchema: htmlOutputSchema,
    semantics: [
      'Inert HTML; text or attribute values in document order, with matchCount/truncated. Up to 48 levels and 8000 nodes/attributes; selectors up to 256 characters, 4 groups and 16 simple tokens.',
      'At most one descendant and one flat structural pseudo-class per group; no general sibling, nested selectors, network or script execution.',
    ],
  }),
]);
