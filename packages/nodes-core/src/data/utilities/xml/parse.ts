import { parseXml, XmlError } from '@rgrove/parse-xml';
import { Parser } from 'htmlparser2';
import { XML_LIMITS } from './validation.js';
import { refuseUtility } from '../result.js';

/** Resource preflight protects the strict parser's recursive element reader. */
export function parseBoundedXml(value: string, signal: AbortSignal) {
  // XML 1.0 §2.11 normalizes source line endings before tokenization.
  const normalized = value.replace(/\r\n?/gu, '\n');
  let depth = 0;
  let members = 0;
  new Parser(
    {
      onopentag: (_name, attributes) => {
        signal.throwIfAborted();
        depth++;
        members += 1 + Object.keys(attributes).length;
        if (depth > XML_LIMITS.depth)
          refuseUtility(
            'xml_depth',
            'The XML is nested too deeply. Use a smaller document.',
          );
        if (members > XML_LIMITS.members)
          refuseUtility(
            'xml_size',
            'The XML has too many elements or attributes. Split the document.',
          );
      },
      onclosetag: () => {
        depth--;
      },
      onprocessinginstruction: (name) => {
        members++;
        if (members > XML_LIMITS.members)
          refuseUtility(
            'xml_size',
            'The XML has too many nodes or attributes. Split the document.',
          );
        if (name.toLowerCase() === '!doctype')
          refuseUtility(
            'xml_dtd',
            'DTD declarations and custom entities are not supported.',
          );
      },
    },
    { xmlMode: true, decodeEntities: false },
  ).end(normalized);
  try {
    return parseXml(normalized);
  } catch (error) {
    if (error instanceof XmlError)
      return refuseUtility(
        'xml_malformed',
        `The XML is malformed at line ${String(error.line)}, column ${String(error.column)}.`,
      );
    throw error;
  }
}
