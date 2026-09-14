import { normalizeAppendControlLedgerRecord } from '../control-ledger.js';
import type {
  AppendControlLedgerRecord,
  ControlLedgerRecord,
} from '../control-ledger.js';

export function exactEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => exactEqual(item, right[index]))
    );
  }
  const leftEntries = Object.entries(left).filter(
    ([, value]) => value !== undefined,
  );
  const rightEntries = Object.entries(right).filter(
    ([, value]) => value !== undefined,
  );
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([key, value]) =>
      Object.hasOwn(right, key)
        ? exactEqual(value, (right as Record<string, unknown>)[key])
        : false,
    )
  );
}

export function normalizeAppendRequest(
  request: AppendControlLedgerRecord,
): AppendControlLedgerRecord {
  const normalizedMaterial = normalizeAppendControlLedgerRecord(request);
  return Object.freeze({
    ...normalizedMaterial,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
}

export function requestMaterialMatches(
  record: ControlLedgerRecord,
  request: AppendControlLedgerRecord,
): boolean {
  const { recordHash, schemaVersion, ...material } = record;
  const { signal, ...requested } = request;
  void recordHash;
  void schemaVersion;
  void signal;
  return exactEqual(material, requested);
}
