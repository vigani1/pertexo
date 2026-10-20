import { XmlElement, XmlText } from '@rgrove/parse-xml';
import type { JsonValue } from '@pertexo/node-sdk/server';
import { refuseUtility } from '../result.js';
import { buildXml } from './build.js';
import { parseBoundedXml } from './parse.js';
import type { XmlConfig } from './validation.js';

const reserved = new Set(['__proto__', 'constructor', 'prototype']);
function convertElement(element: XmlElement, signal: AbortSignal): JsonValue {
  signal.throwIfAborted();
  if (reserved.has(element.name))
    return refuseUtility(
      'xml_name',
      'Reserved object properties are not supported as XML names.',
    );
  const result: Record<string, JsonValue> = Object.create(null) as Record<
    string,
    JsonValue
  >;
  for (const [name, value] of Object.entries(element.attributes)) {
    if (reserved.has(name))
      return refuseUtility(
        'xml_name',
        'Reserved object properties are not supported as XML names.',
      );
    result[`@_${name}`] = value;
  }
  let text = '';
  const children = new Map<string, JsonValue[]>();
  for (const child of element.children) {
    if (child instanceof XmlText) text += child.text;
    else if (child instanceof XmlElement) {
      const values = children.get(child.name) ?? [];
      values.push(convertElement(child, signal));
      children.set(child.name, values);
    }
  }
  if (children.size === 0 && Object.keys(result).length === 0) return text;
  for (const [name, values] of children)
    result[name] = values.length === 1 ? (values[0] ?? '') : values;
  if (text !== '') result['#text'] = text;
  return result;
}
export function transformXml(
  config: XmlConfig,
  value: unknown,
  signal: AbortSignal,
) {
  if (config.operation === 'build') return { value: buildXml(value, signal) };
  if (typeof value !== 'string')
    return refuseUtility('xml_input', 'XML parsing needs text.');
  const root = parseBoundedXml(value, signal).root;
  if (root === null)
    return refuseUtility('xml_root', 'XML needs one root element.');
  return { value: { [root.name]: convertElement(root, signal) } };
}
