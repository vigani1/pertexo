import { createHash, randomUUID } from 'node:crypto';

/** Recovery copies ordinary page files, opaque files and their references. */
export function createRecoveryFiles() {
  const artifacts = [],
    bodies = new Map();
  function add(workspaceId, body, mediaType) {
    const artifact = {
      artifactId: randomUUID(),
      workspaceId,
      byteLength: body.length,
      mediaType,
      sha256: createHash('sha256').update(body).digest('hex'),
    };
    artifacts.push(artifact);
    bodies.set(artifact.artifactId, body);
    return artifact;
  }
  for (let index = 0; index < 2; index++)
    add(
      randomUUID(),
      Buffer.from('matched workflow artifact — UTF-8'),
      'text/plain; charset=utf-8',
    );
  const workspaceId = randomUUID();
  const pages = [
    add(
      workspaceId,
      Buffer.from(JSON.stringify([{ id: 1, text: 'a'.repeat(64000) }])),
      'application/json',
    ),
    add(
      workspaceId,
      Buffer.from(JSON.stringify([{ id: 2, currency: 'EUR', amount: 20 }])),
      'application/json',
    ),
  ].map(({ workspaceId: ignored, ...reference }) => ({
    kind: 'artifact',
    ...reference,
  }));
  add(workspaceId, Buffer.alloc(10485760, 97), 'application/octet-stream');
  return { artifacts, bodies, bundle: { pages, itemCount: 2, pageCount: 2 } };
}
