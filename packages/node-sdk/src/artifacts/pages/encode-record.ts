import { canonicalizeBoundedJson } from '../../values/boundary.js';
import {
  storedExecutionJsonStringBytes,
  StoredExecutionValueInvalidError,
} from '../../values/stored-json.js';
import type { JsonValue } from '../../execution/contract.js';
import { FILE_PAGE_LIMITS } from '../page-limits.js';
import { refuseFilePages } from './failure.js';

/** Already encoded records cross the parser/writer seam without re-serializing a whole result. */
export type EncodedFilePageRecord = Readonly<{
  json: string;
  bytes: number;
  members: number;
}>;
export function encodeFilePageRecord(value: unknown): EncodedFilePageRecord {
  let snapshot: JsonValue;
  try {
    snapshot = canonicalizeBoundedJson(value, {
      bytes: FILE_PAGE_LIMITS.bytes - 2,
      depth: FILE_PAGE_LIMITS.depth - 1,
      members: FILE_PAGE_LIMITS.members - 1,
    });
  } catch {
    refuseFilePages('record');
  }
  let members: number;
  try {
    members = countRecordMembers(snapshot);
  } catch (error) {
    if (error instanceof StoredExecutionValueInvalidError)
      refuseFilePages('text');
    throw error;
  }
  const json = JSON.stringify(snapshot);
  return Object.freeze({
    json,
    bytes: Buffer.byteLength(json, 'utf8'),
    members,
  });
}

function countRecordMembers(snapshot: JsonValue): number {
  let members = 1;
  const pending: JsonValue[] = [snapshot];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') storedExecutionJsonStringBytes(current);
    else if (current !== null && typeof current === 'object') {
      if (Array.isArray(current)) {
        const items = current as readonly JsonValue[];
        members += items.length;
        for (const item of items) pending.push(item);
      } else {
        const object = current as Readonly<Record<string, JsonValue>>;
        const keys = Object.keys(object);
        members += keys.length;
        for (const key of keys) {
          storedExecutionJsonStringBytes(key);
          pending.push(object[key] ?? null);
        }
      }
    }
  }
  return members;
}
