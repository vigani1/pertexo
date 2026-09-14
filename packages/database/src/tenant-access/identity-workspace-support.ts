import { z } from 'zod';

import { IdempotencyRequestConflictError } from '../execution/execution-acceptance.js';
import {
  IdentityConflictError,
  WorkspaceLifecycleConflictError,
  type IdentityConflictReason,
} from './identity-workspace-errors.js';

const uuidSchema = z.uuid();
const IDENTITY_METADATA_MAX_BYTES = 8_192;
const IDENTITY_METADATA_MAX_DEPTH = 32;
const IDENTITY_METADATA_MAX_MEMBERS = 1_024;
const unsafeMetadataKey =
  /(?:password|secret|token|credential|verifier|nonce|private[_-]?key|authorization|cookie)/iu;

export function parseIdentityUuid(value: string): string {
  return uuidSchema.parse(value);
}

type JsonContainer = Record<string, unknown> | unknown[];

interface MetadataFrame {
  readonly source: object;
  readonly target: JsonContainer;
  readonly keys: readonly string[];
  readonly depth: number;
  index: number;
}

class IdentityMetadataValidationError extends Error {
  public override readonly name = 'IdentityMetadataValidationError';
}

function metadataError(message: string): never {
  throw new IdentityMetadataValidationError(message);
}

function assertOrdinaryContainer(value: object, isArray: boolean): void {
  if (Object.getOwnPropertySymbols(value).length > 0)
    metadataError('Identity metadata must contain ordinary JSON data');
  if (isArray) {
    const length = (value as unknown[]).length;
    if (!Number.isSafeInteger(length) || Object.keys(value).length !== length)
      metadataError('Identity metadata must contain ordinary JSON data');
    return;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null)
    metadataError('Identity metadata must contain ordinary JSON data');
}

function assignJsonValue(
  target: JsonContainer,
  key: string,
  value: unknown,
): void {
  if (Array.isArray(target)) target[Number(key)] = value;
  else
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
}

export function parsePersistedIdentityMetadata(
  value: unknown,
): Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      metadataError('Identity metadata must be a JSON object');
    assertOrdinaryContainer(value, false);
    const root: Record<string, unknown> = {};
    const seen = new Set<object>([value]);
    const stack: MetadataFrame[] = [
      {
        source: value,
        target: root,
        keys: Object.keys(value),
        depth: 1,
        index: 0,
      },
    ];
    let members = 0;
    while (stack.length > 0) {
      const frame = stack.at(-1);
      if (frame === undefined) break;
      if (frame.index >= frame.keys.length) {
        Object.freeze(frame.target);
        stack.pop();
        continue;
      }
      const key = frame.keys[frame.index];
      frame.index += 1;
      if (key === undefined) continue;
      members += 1;
      if (members > IDENTITY_METADATA_MAX_MEMBERS)
        metadataError('Identity metadata member limit exceeded');
      if (
        key === '__proto__' ||
        key === 'prototype' ||
        key === 'constructor' ||
        unsafeMetadataKey.test(key)
      )
        metadataError('Unsafe audit metadata key');
      const descriptor = Object.getOwnPropertyDescriptor(frame.source, key);
      if (descriptor === undefined || !('value' in descriptor))
        metadataError('Identity metadata must contain ordinary JSON data');
      const child: unknown = descriptor.value;
      if (
        child === null ||
        typeof child === 'string' ||
        typeof child === 'boolean' ||
        (typeof child === 'number' && Number.isFinite(child))
      ) {
        assignJsonValue(frame.target, key, child);
        continue;
      }
      if (typeof child !== 'object')
        metadataError('Identity metadata must contain ordinary JSON data');
      const childDepth = frame.depth + 1;
      if (childDepth > IDENTITY_METADATA_MAX_DEPTH)
        metadataError('Identity metadata depth limit exceeded');
      if (seen.has(child))
        metadataError('Identity metadata must not repeat object references');
      const childIsArray = Array.isArray(child);
      assertOrdinaryContainer(child, childIsArray);
      const childTarget: JsonContainer = childIsArray ? [] : {};
      assignJsonValue(frame.target, key, childTarget);
      seen.add(child);
      stack.push({
        source: child,
        target: childTarget,
        keys: Object.keys(child),
        depth: childDepth,
        index: 0,
      });
    }
    if (
      Buffer.byteLength(JSON.stringify(root), 'utf8') >
      IDENTITY_METADATA_MAX_BYTES
    )
      metadataError('Identity metadata byte limit exceeded');
    return root;
  } catch (error: unknown) {
    try {
      if (error instanceof IdentityMetadataValidationError) throw error;
    } catch (inspectionError: unknown) {
      if (inspectionError === error) throw error;
    }
    throw new Error('Identity metadata could not be inspected safely');
  }
}

export function parseIdentityMetadata(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return parsePersistedIdentityMetadata(value ?? {});
}

export function readIdentityDatabaseErrorCode(
  error: unknown,
): string | undefined {
  try {
    if (typeof error !== 'object' || error === null) return undefined;
    const code: unknown = Reflect.get(error, 'code');
    return typeof code === 'string' && /^[0-9A-Z]{5}$/u.test(code)
      ? code
      : undefined;
  } catch {
    return undefined;
  }
}

export function throwIdentityDatabaseConflict(
  error: unknown,
  message: string,
  reason: IdentityConflictReason = 'identity',
): never {
  const code = readIdentityDatabaseErrorCode(error);
  if (code === '23505' || code === '23503' || code === '23514')
    throw new IdentityConflictError(message, { cause: error, reason });
  throw error;
}

export function throwWorkspaceLifecycleError(error: unknown): never {
  const code = readIdentityDatabaseErrorCode(error);
  if (code === '23505') throw new IdempotencyRequestConflictError();
  if (code === '42501')
    throw new WorkspaceLifecycleConflictError(
      'actor_inactive',
      'Workspace lifecycle actor is not authorized',
      { cause: error },
    );
  if (code === '55000' || code === '23503')
    throw new WorkspaceLifecycleConflictError(
      'invalid_state',
      'Workspace lifecycle transition is not valid',
      { cause: error },
    );
  throw error;
}
