import { defineUtility } from './definition.js';
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
  defineUtility(
    'core.text',
    textConfigSchema,
    textInputSchema,
    textOutputSchema,
    [
      'Exact mapped Unicode text; explicit en-US casing; replace and split use literal strings, never regular expressions. Truncation counts code points and includes any ellipsis in its limit.',
    ],
  ),
  defineUtility(
    'core.number',
    numberConfigSchema,
    numberInputSchema,
    numberOutputSchema,
    [
      'Format finite numbers using an explicit Intl locale; decimal, percentage or currency. No implicit parsing or exchange rates.',
    ],
  ),
  defineUtility(
    'core.crypto',
    cryptoConfigSchema,
    cryptoInputSchema,
    cryptoOutputSchema,
    [
      'Hash exact UTF-8 bytes. MD5 is not for security. UUID and random IDs use the cryptographic system RNG; re-execution produces a new value.',
    ],
  ),
  defineUtility(
    'core.hmac',
    hmacConfigSchema,
    hmacInputSchema,
    hmacOutputSchema,
    [
      'Sign exact mapped UTF-8 bytes with SHA-256 or SHA-512 and a workspace-bound encrypted Signing key connection. No key in config, inputs or output.',
    ],
    'hmac_key',
  ),
  defineUtility('core.xml', xmlConfigSchema, xmlInputSchema, xmlOutputSchema, [
    'XML data conversion preserves strings, namespace prefixes, @_ attributes, #text and repeated sibling arrays. No DTD, external entities or processing instructions. At most 48 nested tags and 8000 elements/attributes.',
  ]),
  defineUtility(
    'core.html',
    htmlConfigSchema,
    htmlInputSchema,
    htmlOutputSchema,
    [
      'Inert HTML; text or attribute values in document order, with matchCount/truncated. Up to 48 levels and 8000 nodes/attributes; selectors up to 256 characters, 4 groups and 16 simple tokens.',
      'At most one descendant and one flat structural pseudo-class per group; no general sibling, nested selectors, network or script execution.',
    ],
  ),
]);
