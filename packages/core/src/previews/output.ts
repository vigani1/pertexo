import {
  parseStoredExecutionValue,
  serializeStoredExecutionValue,
} from '../runs/values/stored-execution.js';
import type { StoredExecutionValue } from '@pertexo/database/schema';

export function isValidStoredExecutionOutput(
  value: unknown,
): value is StoredExecutionValue {
  try {
    // The descriptor-based stored-value module is the single admission
    // contract. It rejects accessors, proxies and lossy JSON shapes without
    // invoking caller-controlled properties, then proves canonical stability.
    const serialized = serializeStoredExecutionValue(value);
    const reparsed = parseStoredExecutionValue(serialized);
    return serializeStoredExecutionValue(reparsed) === serialized;
  } catch {
    return false;
  }
}
