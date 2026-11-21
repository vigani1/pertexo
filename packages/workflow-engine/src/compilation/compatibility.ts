import { createHash } from 'node:crypto';
import { canonicalJson, utf8ByteLength } from '@pertexo/workflow-model';
import {
  createNodeCatalog,
  parseNodeCatalog,
  type NodeCatalog,
} from '@pertexo/node-sdk';
import {
  BASELINE_RUNTIME_POLICIES,
  globalPolicies,
} from './runtime-policies.js';
import { fail, readUntrusted } from './executable.errors.js';

type ExecutableCatalogFingerprint = Readonly<{ sha256: string; bytes: number }>;
const composedCatalogs = new WeakMap<
  object,
  ExecutableCatalogFingerprint | null
>();

export function composeExecutableCatalog(
  nodeCatalogInput: unknown,
): NodeCatalog {
  return readUntrusted(() => {
    const nodeCatalog = parseNodeCatalog(nodeCatalogInput);
    if (nodeCatalog.policies.some(({ key }) => key.startsWith('engine.')))
      fail('node catalog must not declare engine runtime policies');
    const catalog = createNodeCatalog({
      definitions: nodeCatalog.definitions,
      executors: nodeCatalog.executors,
      policies: [
        ...nodeCatalog.policies,
        ...globalPolicies(BASELINE_RUNTIME_POLICIES),
      ],
    });
    composedCatalogs.set(catalog, null);
    return catalog;
  });
}

/** Composed catalogs are deeply frozen. Other inputs must be read afresh. */
export function fingerprintExecutableCatalog(
  catalog: unknown,
): ExecutableCatalogFingerprint {
  const key = catalog as object;
  const cached = composedCatalogs.get(key);
  if (cached != null) return cached;
  const json = canonicalJson(catalog);
  const fingerprint = Object.freeze({
    sha256: createHash('sha256').update(json).digest('hex'),
    bytes: utf8ByteLength(json),
  });
  if (cached === null) composedCatalogs.set(key, fingerprint);
  return fingerprint;
}
