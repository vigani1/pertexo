import type {
  DefinitionIdentity,
  ExecutorIdentity,
  ExecutorManifest,
  NodeManifest,
  PolicyReference,
  RegistryRelease,
  RegistryReleaseInput,
} from './release.js';

function identityToken(
  identity: DefinitionIdentity | ExecutorIdentity | PolicyReference,
): string {
  return `${identity.key}\u0000${String(identity.version)}`;
}

function compareIdentity(
  left: DefinitionIdentity | ExecutorIdentity | PolicyReference,
  right: DefinitionIdentity | ExecutorIdentity | PolicyReference,
): number {
  return left.key < right.key
    ? -1
    : left.key > right.key
      ? 1
      : left.version - right.version;
}

export function cloneAndFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    for (const item of value) copy.push(cloneAndFreeze(item));
    return Object.freeze(copy) as T;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value))
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value: cloneAndFreeze(item),
      writable: true,
    });
  return Object.freeze(copy) as T;
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

/** Small synchronous SHA-256 implementation so the browser contract has no Node dependency. */
function sha256Hex(input: string): string {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = ((bytes.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bitLength >>> 0);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const schedule = new Uint32Array(64);
  const rotateRight = (value: number, amount: number): number =>
    (value >>> amount) | (value << (32 - amount));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1)
      schedule[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const previous = schedule[index - 15] ?? 0;
      const older = schedule[index - 2] ?? 0;
      const sigma0 =
        rotateRight(previous, 7) ^ rotateRight(previous, 18) ^ (previous >>> 3);
      const sigma1 =
        rotateRight(older, 17) ^ rotateRight(older, 19) ^ (older >>> 10);
      schedule[index] =
        ((schedule[index - 16] ?? 0) +
          sigma0 +
          (schedule[index - 7] ?? 0) +
          sigma1) >>>
        0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 =
        rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 =
        (h +
          bigSigma1 +
          choose +
          (constants[index] ?? 0) +
          (schedule[index] ?? 0)) >>>
        0;
      const bigSigma0 =
        rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const temporary2 = (bigSigma0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('');
}

export function definitionProjection(manifest: NodeManifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    definition: manifest.definition,
    family: manifest.family,
    configVersion: manifest.configVersion,
    configSchema: manifest.configSchema,
    inputSchema: manifest.inputSchema,
    outputSchema: manifest.outputSchema,
    ports: {
      inputs: [...manifest.ports.inputs].sort(),
      outputs: [...manifest.ports.outputs].sort(),
    },
    credentialRequirements: [...manifest.credentialRequirements].sort(),
    connectionRequirements: [...manifest.connectionRequirements].sort(),
    ...(manifest.integration === undefined
      ? {}
      : { integration: manifest.integration }),
    retryClass: manifest.retryClass,
    resourceClass: manifest.resourceClass,
    capabilities: [...manifest.capabilities].sort(),
    lifecycle: manifest.lifecycle,
    executor: manifest.executor,
    executorAbi: manifest.executorAbi ?? null,
    policyReferences: [...manifest.policyReferences].sort(compareIdentity),
  };
}

export function executorProjection(executor: ExecutorManifest) {
  return {
    executor: executor.executor,
    abiVersion: executor.abiVersion,
    definitions: [...executor.definitions].sort(compareIdentity),
    lifecycle: executor.lifecycle,
    policyReferences: [...executor.policyReferences].sort(compareIdentity),
  };
}

function releaseProjection(input: RegistryReleaseInput): unknown {
  return {
    domain: 'pertexo.node-compatibility-release',
    schemaVersion: 1,
    definitions: [...input.definitions]
      .sort((left, right) => compareIdentity(left.definition, right.definition))
      .map(definitionProjection),
    executors: [...input.executors]
      .sort((left, right) => compareIdentity(left.executor, right.executor))
      .map(executorProjection),
    policies: [...input.policies].sort(compareIdentity),
  };
}

export function canonicalCompatibilityReleaseJson(
  release: RegistryReleaseInput,
): string {
  return stableJson(releaseProjection(release));
}

export function computeCompatibilityReleaseFingerprint(
  release: RegistryReleaseInput,
): string {
  return `node-compat:v1:sha256:${sha256Hex(canonicalCompatibilityReleaseJson(release))}`;
}

export function computeSelectionFingerprintFromParsedRelease(
  release: RegistryRelease,
  selectedDefinitions: readonly DefinitionIdentity[],
): string {
  const definitions = new Map(
    release.definitions.map((manifest) => [
      identityToken(manifest.definition),
      manifest,
    ]),
  );
  const executors = new Map(
    release.executors.map((manifest) => [
      identityToken(manifest.executor),
      manifest,
    ]),
  );
  const policies = new Map(
    release.policies.map((policy) => [identityToken(policy), policy]),
  );
  const projection = [...selectedDefinitions]
    .sort(compareIdentity)
    .map((selection) => {
      const definition = definitions.get(identityToken(selection));
      const executor =
        definition === undefined
          ? undefined
          : executors.get(identityToken(definition.executor));
      if (definition === undefined || executor === undefined)
        throw new Error('compatibility selection contains an unknown identity');
      const selectedPolicies = [...definition.policyReferences]
        .sort(compareIdentity)
        .map((policy) => {
          const known = policies.get(identityToken(policy));
          if (known === undefined)
            throw new Error(
              'compatibility selection contains an unknown policy',
            );
          return known;
        });
      return {
        definition: definitionProjection(definition),
        executor: executorProjection(executor),
        policies: selectedPolicies,
      };
    });
  return `node-select:v1:sha256:${sha256Hex(stableJson({ domain: 'pertexo.node-compatibility-selection', selections: projection }))}`;
}
