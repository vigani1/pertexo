import { z } from 'zod';

const service = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/u),
  port: z.number().int().min(1024).max(65535),
});
const manifestSchema = z.strictObject({
  project: z.string().regex(/^pertexo-[a-z0-9-]+$/u),
  postgres: service,
  redis: service,
  artifactStore: service.optional(),
});
const inspectedSchema = z
  .array(
    z.object({
      Id: z.string(),
      State: z.object({ Running: z.boolean() }),
      Config: z.object({ Labels: z.record(z.string(), z.string()) }),
      NetworkSettings: z.object({
        Ports: z.record(
          z.string(),
          z
            .array(z.object({ HostIp: z.string(), HostPort: z.string() }))
            .nullable(),
        ),
      }),
    }),
  )
  .length(1);

/** Attestation is supplied only after task ownership approval, never discovery. */
export async function verifyEditorBrowserOwnership(
  env: Readonly<Record<string, string | undefined>>,
  inspect: (id: string) => Promise<string>,
): Promise<void> {
  if (env.EDITOR_BROWSER_OWNED_FIXTURE !== 'true')
    throw new Error('Explicit disposable-fixture ownership is required');
  const manifest = manifestSchema.parse(
    JSON.parse(env.EDITOR_BROWSER_OWNERSHIP_MANIFEST ?? 'null'),
  );
  if (manifest.postgres.port === 55435 || manifest.redis.port === 56379)
    throw new Error('The older shared fixture is prohibited');
  verifyDatabaseUrls(env, manifest);
  verifyRedisUrl(env, manifest);
  await verifyArtifactStore(env, manifest, inspect);
  await verifyServices(manifest, inspect);
}

type OwnershipManifest = z.output<typeof manifestSchema>;
function verifyDatabaseUrls(
  env: Readonly<Record<string, string | undefined>>,
  manifest: OwnershipManifest,
): void {
  for (const name of [
    'DATABASE_ADMIN_URL',
    'DATABASE_MIGRATION_URL',
    'DATABASE_URL',
    'DATABASE_MAINTENANCE_URL',
  ] as const) {
    const configured = env[name];
    if (configured === undefined)
      throw new Error(`Explicit ${name} is required`);
    const url = new URL(configured);
    if (
      url.protocol !== 'postgresql:' ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.port !== String(manifest.postgres.port)
    )
      throw new Error('PostgreSQL URLs must match the approved owned manifest');
  }
}

function verifyRedisUrl(
  env: Readonly<Record<string, string | undefined>>,
  manifest: OwnershipManifest,
): void {
  const redis = new URL(env.REDIS_URL ?? '');
  if (
    redis.protocol !== 'redis:' ||
    !['localhost', '127.0.0.1'].includes(redis.hostname) ||
    redis.port !== String(manifest.redis.port)
  )
    throw new Error('Redis URL must match the approved owned manifest');
}

async function verifyArtifactStore(
  env: Readonly<Record<string, string | undefined>>,
  manifest: OwnershipManifest,
  inspect: (id: string) => Promise<string>,
): Promise<void> {
  if (
    (env.EDITOR_BROWSER_CASE === 'artifact-inputs' ||
      env.EDITOR_BROWSER_CASE === 'spreadsheets') &&
    manifest.artifactStore === undefined
  )
    throw new Error(
      'File browser qualification requires an attested object store',
    );
  if (manifest.artifactStore !== undefined) {
    const owned = manifest.artifactStore;
    const endpoint = new URL(env.ARTIFACT_STORE_ENDPOINT ?? '');
    if (
      endpoint.protocol !== 'http:' ||
      endpoint.hostname !== '127.0.0.1' ||
      endpoint.port !== String(owned.port)
    )
      throw new Error(
        'Object-store URL must match the approved owned manifest',
      );
    const inspected = inspectedSchema.parse(
      JSON.parse(await inspect(owned.id)),
    )[0];
    const bindings = Object.entries(inspected?.NetworkSettings.Ports ?? {})
      .filter(([port]) => ['9000/tcp', '9090/tcp'].includes(port))
      .flatMap(([, values]) => values ?? []);
    if (
      inspected?.Id !== owned.id ||
      !inspected.State.Running ||
      (inspected.Config.Labels['com.docker.compose.project'] !==
        manifest.project &&
        inspected.Config.Labels['pertexo.fixture.owner'] !==
          manifest.project) ||
      bindings.length !== 1 ||
      bindings[0]?.HostIp !== '127.0.0.1' ||
      bindings[0].HostPort !== String(owned.port)
    )
      throw new Error('Owned object-store preflight failed');
  }
}

async function verifyServices(
  manifest: OwnershipManifest,
  inspect: (id: string) => Promise<string>,
): Promise<void> {
  for (const [owned, port] of [
    [manifest.postgres, '5432/tcp'],
    [manifest.redis, '6379/tcp'],
  ] as const) {
    const inspected = inspectedSchema.parse(
      JSON.parse(await inspect(owned.id)),
    )[0];
    const bindings = inspected?.NetworkSettings.Ports[port];
    if (
      inspected?.Id !== owned.id ||
      !inspected.State.Running ||
      inspected.Config.Labels['com.docker.compose.project'] !==
        manifest.project ||
      bindings?.length !== 1 ||
      bindings[0]?.HostIp !== '127.0.0.1' ||
      bindings[0].HostPort !== String(owned.port)
    )
      throw new Error('Owned integration service preflight failed');
  }
}
