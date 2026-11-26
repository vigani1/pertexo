import { formatCount } from '@pertexo/node-sdk';
import { defineUtility } from './define-utility.js';
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
  HTML_LIMITS,
  htmlConfigSchema,
  htmlInputSchema,
  htmlOutputSchema,
} from './html/html.schemas.js';

export const CORE_TEXT_REGISTRATION = defineUtility({
  key: 'core.text',
  assistantDisclosure: {
    config: { visible: ['operation', 'all', 'length', 'ellipsis'], masked: [] },
    inputs: {
      visible: ['value', 'search', 'replacement', 'delimiter'],
      masked: [],
    },
  } as const,
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
});

export const CORE_NUMBER_REGISTRATION = defineUtility({
  key: 'core.number',
  assistantDisclosure: {
    config: {
      visible: [
        'operation',
        'locale',
        'grouping',
        'minimumFractionDigits',
        'maximumFractionDigits',
        'currency',
      ],
      masked: [],
    },
    inputs: { visible: ['value'], masked: [] },
  } as const,
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
});

export const CORE_CRYPTO_REGISTRATION = defineUtility({
  key: 'core.crypto',
  assistantDisclosure: {
    config: {
      visible: ['operation', 'algorithm', 'encoding', 'length'],
      masked: [],
    },
    inputs: { visible: ['value'], masked: [] },
  } as const,
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
});

export const CORE_HMAC_REGISTRATION = defineUtility({
  key: 'core.hmac',
  assistantDisclosure: {
    config: { visible: ['algorithm', 'encoding'], masked: [] },
    inputs: { visible: ['value'], masked: [] },
  } as const,
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
});

export const CORE_XML_REGISTRATION = defineUtility({
  key: 'core.xml',
  assistantDisclosure: {
    config: { visible: ['operation'], masked: [] },
    inputs: { visible: ['value'], masked: [] },
  } as const,
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
});

export const CORE_HTML_REGISTRATION = defineUtility({
  key: 'core.html',
  assistantDisclosure: {
    config: {
      visible: ['operation', 'selector', 'limit', 'attribute'],
      masked: [],
    },
    inputs: { visible: ['value'], masked: [] },
  } as const,
  display: {
    name: 'Extract HTML',
    description: 'Select text or attributes with CSS selectors',
  },
  configSchema: htmlConfigSchema,
  inputSchema: htmlInputSchema,
  outputSchema: htmlOutputSchema,
  semantics: [
    `Inert HTML; text or attribute values in document order, with matchCount/truncated. Up to ${String(HTML_LIMITS.depth)} levels and ${formatCount(HTML_LIMITS.nodes)} nodes/attributes; selectors up to ${String(HTML_LIMITS.selectorCharacters)} characters, ${String(HTML_LIMITS.selectorGroups)} groups and ${String(HTML_LIMITS.selectorTokens)} simple tokens.`,
    'At most one descendant and one flat structural pseudo-class per group; no general sibling, nested selectors, network or script execution.',
  ],
});
