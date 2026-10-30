import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  decodeResponse,
  parseXml,
} from '../../../../src/authentication/federation/protocol/saml/xml.js';

// A SAML response is the one parser a stranger can reach before signing in.
const PIECES = [
  '<a>',
  '</a>',
  '<a ID="1">',
  '<a ID="1" ID="1">',
  '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">',
  '</samlp:Response>',
  '<',
  '>',
  '&',
  '&#0;',
  '&lol;',
  '<![CDATA[',
  ']]>',
  '<!--',
  '-->',
  '<?xml version="1.0"?>',
  '<!DOCTYPE a [<!ENTITY lol "lol">]>',
  '\0',
  'text',
];

const INVALID = 'SAML identity proof is invalid';

/** Either a parsed document or the one refusal; never a parser's own error. */
function expectParsedOrRefused(run: () => unknown): void {
  try {
    run();
  } catch (error: unknown) {
    expect(error).toEqual(new Error(INVALID));
  }
}

describe('SAML response parsing given hostile input', () => {
  it('parses or refuses any text', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 512 }),
          fc
            .array(fc.constantFrom(...PIECES), { maxLength: 200 })
            .map((pieces) => pieces.join('')),
          fc
            .integer({ min: 1, max: 20_000 })
            .map((depth) => '<a>'.repeat(depth)),
        ),
        (xml) => {
          expectParsedOrRefused(() => parseXml(xml));
        },
      ),
      { numRuns: 500 },
    );
  });

  // Found by this fuzz (no audit ID): invalid UTF-8 escapes as the decoder's TypeError.
  it.fails('decodes or refuses any encoded response', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 512 }),
          fc
            .uint8Array({ maxLength: 512 })
            .map((bytes) => Buffer.from(bytes).toString('base64')),
        ),
        (value) => {
          expectParsedOrRefused(() => decodeResponse(value));
        },
      ),
      { numRuns: 500 },
    );
  });
});
