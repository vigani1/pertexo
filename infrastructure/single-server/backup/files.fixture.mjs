import { createHash, randomUUID } from 'node:crypto';

export function createRecoveryFiles() {
  const body = Buffer.from('matched workflow artifact — UTF-8');
  const artifacts = [0, 1].map(() => ({
    artifactId: randomUUID(),
    workspaceId: randomUUID(),
    byteLength: body.length,
    mediaType: 'text/plain; charset=utf-8',
    sha256: createHash('sha256').update(body).digest('hex'),
  }));
  return { body, artifacts };
}
