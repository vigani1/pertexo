import { COLLECTION_MAX_ITEMS } from '../../lists/semantics/validation.js';
import { STORED_EXECUTION_VALUE_LIMITS } from '@pertexo/node-sdk';
import XMLBuilder from 'fast-xml-builder';
import { parseBoundedXml } from './parse.js';
import { qName } from 'xml-naming';
import { isRecord } from '@pertexo/workflow-model';
import { refuseUtility } from '../result.js';

const reserved = new Set(['__proto__', 'constructor', 'prototype']);
function checkValue(value: unknown, signal: AbortSignal): void {
  signal.throwIfAborted();
  if (Array.isArray(value)) {
    if (value.length > COLLECTION_MAX_ITEMS)
      refuseUtility(
        'too_many_items',
        'An XML input list exceeds 4,998 items. Split the input into smaller batches.',
      );
    for (const item of value) checkValue(item, signal);
    return;
  }
  if (!isRecord(value)) return;
  for (const [name, item] of Object.entries(value)) {
    if (name === '#text' || name.startsWith('@_')) {
      if (
        (name !== '#text' &&
          (!qName(name.slice(2)) || reserved.has(name.slice(2)))) ||
        (item !== null && typeof item === 'object')
      )
        refuseUtility(
          'xml_data',
          'XML attributes and #text must be scalar values with valid XML names.',
        );
    } else {
      if (!qName(name) || reserved.has(name))
        refuseUtility(
          'xml_name',
          'Use valid XML element names, not reserved object properties.',
        );
      checkValue(item, signal);
    }
  }
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
  checkValue(value, signal);
  const result: unknown = new XMLBuilder({
    ignoreAttributes: false,
    processEntities: true,
    suppressEmptyNode: true,
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
