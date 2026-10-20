import { COLLECTION_MAX_ITEMS } from '../../lists/semantics/validation.js';
import { STORED_EXECUTION_VALUE_LIMITS } from '@pertexo/node-sdk';
import XMLBuilder from 'fast-xml-builder';
import { parseBoundedXml } from './parse.js';
import { qName } from 'xml-naming';
import { XML_LIMITS } from './validation.js';
import { isRecord } from '@pertexo/workflow-model';
import { refuseUtility } from '../result.js';

const reserved = new Set(['__proto__', 'constructor', 'prototype']);
function addBytes(left: number, right: number): number {
  const bytes = left + right;
  if (bytes > STORED_EXECUTION_VALUE_LIMITS.inlineBytes)
    refuseUtility(
      'result_too_large',
      'The XML result exceeds the step data limits. Split the input into smaller batches.',
    );
  return bytes;
}

function nameBytes(name: string): number {
  if (!qName(name) || reserved.has(name))
    refuseUtility(
      'xml_name',
      'Use valid XML element and attribute names, not reserved object properties.',
    );
  return Buffer.byteLength(name);
}

/** Count expansion before the library allocates escaped text or repeated tags. */
function textBytes(value: unknown): number {
  if (
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'boolean'
  )
    refuseUtility(
      'xml_data',
      'XML attributes and #text must be text, numbers or booleans.',
    );
  const text = Object.is(value, -0) ? '-0' : String(value);
  let bytes = addBytes(0, Buffer.byteLength(text));
  for (const match of text.matchAll(/[&<>"']/gu))
    bytes = addBytes(
      bytes,
      match[0] === '&' ? 4 : match[0] === '<' || match[0] === '>' ? 3 : 5,
    );
  return bytes;
}

function measureElement(
  tagBytes: number,
  value: unknown,
  depth: number,
  signal: AbortSignal,
  counts: { members: number },
): number {
  signal.throwIfAborted();
  if (Array.isArray(value)) {
    if (value.length > COLLECTION_MAX_ITEMS)
      refuseUtility(
        'too_many_items',
        'An XML input list exceeds 4,998 items. Split the input into smaller batches.',
      );
    let bytes = 0;
    for (const item of value) {
      if (Array.isArray(item))
        refuseUtility(
          'xml_data',
          'Nested XML lists need named child elements.',
        );
      bytes = addBytes(
        bytes,
        measureElement(tagBytes, item, depth, signal, counts),
      );
    }
    return bytes;
  }
  if (depth > XML_LIMITS.depth)
    refuseUtility(
      'xml_depth',
      'The XML is nested too deeply. Use a smaller document.',
    );
  counts.members++;
  let attributes = 0;
  let content = 0;
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith('@_')) {
        counts.members++;
        const attributeBytes = nameBytes(key.slice(2));
        if (item !== null)
          attributes = addBytes(
            attributes,
            addBytes(attributeBytes + 4, textBytes(item)),
          );
      } else if (key === '#text') content = addBytes(content, textBytes(item));
      else
        content = addBytes(
          content,
          measureElement(nameBytes(key), item, depth + 1, signal, counts),
        );
    }
  } else if (value !== null) content = textBytes(value);
  if (counts.members > XML_LIMITS.members)
    refuseUtility(
      'xml_size',
      'The XML has too many elements or attributes. Split the document.',
    );
  return addBytes(
    addBytes(tagBytes + 3, attributes),
    content === 0 ? 0 : addBytes(tagBytes + 2, content),
  );
}
export function buildXml(value: unknown, signal: AbortSignal) {
  if (!isRecord(value) || Object.keys(value).length !== 1)
    return refuseUtility(
      'xml_root',
      'XML needs an object with exactly one root element.',
    );
  const [root] = Object.keys(value);
  if (
    root === undefined ||
    root.startsWith('@_') ||
    root === '#text' ||
    Array.isArray(value[root])
  )
    return refuseUtility(
      'xml_root',
      'XML needs exactly one root element, not an array or an attribute.',
    );
  measureElement(nameBytes(root), value[root], 1, signal, { members: 0 });
  const result: unknown = new XMLBuilder({
    ignoreAttributes: false,
    processEntities: true,
    suppressEmptyNode: true,
    suppressBooleanAttributes: false,
  }).build(value);
  if (typeof result !== 'string')
    return refuseUtility(
      'xml_data',
      'The value cannot be represented as valid XML. Check names and text characters.',
    );
  if (Buffer.byteLength(result) > STORED_EXECUTION_VALUE_LIMITS.inlineBytes)
    refuseUtility(
      'result_too_large',
      'The XML result exceeds the step data limits. Split the input into smaller batches.',
    );
  parseBoundedXml(result, signal);
  return result;
}
