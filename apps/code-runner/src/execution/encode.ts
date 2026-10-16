import { types } from 'node:util';
import { Buffer } from 'node:buffer';

// User code may mutate its realm. Capture inspection/encoding primitives first.
const descriptor = Object.getOwnPropertyDescriptor;
const prototype = Object.getPrototypeOf;
const own = Object.hasOwn;
const keys = Reflect.ownKeys;
const array = Array.isArray;
const finite = Number.isFinite;
const stringify = JSON.stringify;
const string = String;
const byteLength = Buffer.byteLength.bind(Buffer);
const objectPrototype = Object.prototype;
const arrayPrototype = Array.prototype;
const proxy = types.isProxy;
type Ancestor = Readonly<{ value: object; parent: Ancestor | undefined }>;

export type JsonBounds = Readonly<{
  bytes: number;
  depth: number;
  members: number;
}>;
export class InvalidCodeOutput extends Error {}
export function quote(value: string): string {
  return stringify(value);
}
export function encodeCodeJson(value: unknown, limits: JsonBounds): string {
  let members = 0,
    bytes = 0,
    encoded = '';
  const append = (piece: string) => {
    bytes += byteLength(piece, 'utf8');
    if (bytes > limits.bytes)
      throw new InvalidCodeOutput(
        'Code output exceeds 1 MB. Return less data.',
      );
    encoded += piece;
  };
  const walk = (
    item: unknown,
    depth: number,
    ancestors: Ancestor | undefined,
  ): void => {
    if (item === null) {
      append('null');
      return;
    }
    if (typeof item === 'boolean') {
      append(item ? 'true' : 'false');
      return;
    }
    if (typeof item === 'number' && finite(item)) {
      append(string(item));
      return;
    }
    if (typeof item === 'string') {
      if (item.length > limits.bytes)
        throw new InvalidCodeOutput(
          'Code output exceeds 1 MB. Return less data.',
        );
      append(quote(item));
      return;
    }
    if (typeof item !== 'object' || proxy(item))
      throw new InvalidCodeOutput(
        'Return plain JSON without functions, proxies, undefined or non-finite numbers.',
      );
    if (depth > limits.depth)
      throw new InvalidCodeOutput(
        'Code output exceeds the JSON depth limit. Return less data.',
      );
    const isArray = array(item),
      expected = isArray ? arrayPrototype : objectPrototype;
    if (prototype(item) !== expected && !(prototype(item) === null && !isArray))
      throw new InvalidCodeOutput(
        'Return plain JSON; convert class instances and dates to plain values.',
      );
    let ancestor = ancestors;
    while (ancestor !== undefined) {
      if (ancestor.value === item)
        throw new InvalidCodeOutput('Code output contains a cycle.');
      ancestor = ancestor.parent;
    }
    const parent = { value: item, parent: ancestors };
    const properties = keys(item);
    if (properties.length > limits.members + 1)
      throw new InvalidCodeOutput('Code output has too many members.');
    if (isArray) {
      const length = descriptor(item, 'length');
      const count: unknown = length?.value;
      if (
        typeof count !== 'number' ||
        count > limits.members ||
        properties.length !== count + 1
      )
        throw new InvalidCodeOutput(
          'Return a plain JSON array without extra properties or holes.',
        );
      append('[');
      for (let index = 0; index < count; index++) {
        if (index > 0) append(',');
        const entry = descriptor(item, string(index));
        if (entry === undefined || !own(entry, 'value') || !entry.enumerable)
          throw new InvalidCodeOutput(
            'Code output contains an accessor or array hole.',
          );
        if (++members > limits.members)
          throw new InvalidCodeOutput(
            'Code output exceeds the JSON member limit. Return less data.',
          );
        walk(entry.value as unknown, depth + 1, parent);
      }
      append(']');
    } else {
      append('{');
      let index = 0;
      while (index < properties.length) {
        const key = properties[index];
        if (typeof key !== 'string')
          throw new InvalidCodeOutput(
            'Code output contains a symbol property.',
          );
        const entry = descriptor(item, key);
        if (entry === undefined || !own(entry, 'value') || !entry.enumerable)
          throw new InvalidCodeOutput(
            'Code output contains an accessor or hidden property.',
          );
        if (index > 0) append(',');
        append(quote(key));
        append(':');
        if (++members > limits.members)
          throw new InvalidCodeOutput(
            'Code output exceeds the JSON member limit. Return less data.',
          );
        walk(entry.value as unknown, depth + 1, parent);
        index++;
      }
      append('}');
    }
  };
  walk(value, 1, undefined);
  return encoded;
}
