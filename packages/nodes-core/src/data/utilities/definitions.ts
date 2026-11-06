import { defineUtility } from './registration.js';
import {
  textConfigSchema,
  textInputSchema,
  textOutputSchema,
} from './text/text.schemas.js';
import {
  numberConfigSchema,
  numberInputSchema,
  numberOutputSchema,
} from './number/number.schemas.js';
import {
  cryptoConfigSchema,
  cryptoInputSchema,
  cryptoOutputSchema,
} from './crypto/crypto.schemas.js';
import {
  hmacConfigSchema,
  hmacInputSchema,
  hmacOutputSchema,
} from './hmac/hmac.schemas.js';
import {
  xmlConfigSchema,
  xmlInputSchema,
  xmlOutputSchema,
} from './xml/xml.schemas.js';
import {
  htmlConfigSchema,
  htmlInputSchema,
  htmlOutputSchema,
} from './html/html.schemas.js';

export const UTILITY_DEFINITIONS = Object.freeze([
  defineUtility({
    key: 'core.text',
    display: {
      name: 'Format text',
      description: 'Case, trim, replace, split or truncate text',
    },
    configSchema: textConfigSchema,
    inputSchema: textInputSchema,
    outputSchema: textOutputSchema,
    semantics: [
      'Exact mapped Unicode text; explicit en-US casing; replace and split use literal strings, never regular expressions. Truncation counts code points and includes any ellipsis in its limit.',
    ],
  }),
  defineUtility({
    key: 'core.number',
    display: {
      name: 'Format number',
      description: 'Format decimals, percentages and currency',
    },
    configSchema: numberConfigSchema,
    inputSchema: numberInputSchema,
    outputSchema: numberOutputSchema,
    semantics: [
      'Format finite numbers using an explicit Intl locale; decimal, percentage or currency. No implicit parsing or exchange rates.',
    ],
  }),
  defineUtility({
    key: 'core.crypto',
    display: {
      name: 'Crypto',
      description: 'Hash text or generate UUIDs and random IDs',
    },
    configSchema: cryptoConfigSchema,
    inputSchema: cryptoInputSchema,
    outputSchema: cryptoOutputSchema,
    semantics: [
      'Hash exact UTF-8 bytes. MD5 is not for security. UUID and random IDs use the cryptographic system RNG; re-execution produces a new value.',
    ],
  }),
  defineUtility({
    key: 'core.hmac',
    display: {
      name: 'HMAC signature',
      description: 'Sign text with an encrypted key',
    },
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
    display: {
      name: 'Convert XML',
      description: 'Convert XML to JSON and back',
    },
    configSchema: xmlConfigSchema,
    inputSchema: xmlInputSchema,
    outputSchema: xmlOutputSchema,
    semantics: [
      'XML data conversion preserves strings, namespace prefixes, @_ attributes, #text and repeated sibling arrays. No DTD, external entities or processing instructions; a standard XML declaration is allowed. At most 48 nested tags and 8000 elements/attributes.',
    ],
  }),
  defineUtility({
    key: 'core.html',
    display: {
      name: 'Extract HTML',
      description: 'Select text or attributes with CSS selectors',
    },
    configSchema: htmlConfigSchema,
    inputSchema: htmlInputSchema,
    outputSchema: htmlOutputSchema,
    semantics: [
      'Inert HTML; text or attribute values in document order, with matchCount/truncated. Up to 48 levels and 8000 nodes/attributes; selectors up to 256 characters, 4 groups and 16 simple tokens.',
      'At most one descendant and one flat structural pseudo-class per group; no general sibling, nested selectors, network or script execution.',
    ],
  }),
]);
