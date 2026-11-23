import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  compileCommunityManifest,
  communityProviderKey,
  COMMUNITY_MANIFEST_LIMITS,
  decodeCommunityManifest,
  type IntegrationModule,
} from '@pertexo/integrations/server';
import { mergeCommunityReleases } from './merge-community-releases.js';
import type { CommunityApproval, CommunityApprovalSet } from './approvals.js';
import { CommunityApprovalError } from './approval.errors.js';

export async function loadCommunityModules(
  { root, approvals }: CommunityApprovalSet,
  onVerifiedFile?: (
    approval: CommunityApproval,
    bytes: Uint8Array,
  ) => Promise<void>,
): Promise<readonly IntegrationModule[]> {
  if (!path.isAbsolute(root) || (await realpath(root)) !== root)
    throw new CommunityApprovalError(
      'package root must be absolute and contain no symlinks',
    );
  const releases = [];
  for (const approval of approvals) {
    const identity = `${approval.providerKey}@${approval.version}`;
    try {
      const bytes = await readPackage(root, approval.file);
      const { manifest } = decodePackage(bytes, approval.sha256);
      if (
        communityProviderKey(manifest) !== approval.providerKey ||
        manifest.version !== approval.version ||
        manifest.origin !== approval.origin
      )
        throw new CommunityApprovalError(
          'manifest identity, release or origin does not match approval',
        );
      releases.push({ approval, module: compileCommunityManifest(manifest) });
      await onVerifiedFile?.(approval, bytes);
    } catch (cause) {
      const detail =
        cause instanceof Error ? cause.message : 'package could not be read';
      throw new CommunityApprovalError(`${identity}: ${detail}`, { cause });
    }
  }
  return mergeCommunityReleases(releases);
}

async function readPackage(root: string, file: string): Promise<Uint8Array> {
  if (file.includes('\\') || file.includes('\0') || path.isAbsolute(file))
    throw new CommunityApprovalError(
      'package path must be relative to the package root',
    );
  const segments = file.split('/');
  if (
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    )
  )
    throw new CommunityApprovalError(
      'package path contains an invalid segment',
    );

  let candidate = root;
  for (const directory of segments.slice(0, -1)) {
    candidate = path.join(candidate, directory);
    if (!(await lstat(candidate)).isDirectory())
      throw new CommunityApprovalError(
        'package path crosses a symlink or non-directory',
      );
  }
  candidate = path.join(candidate, path.basename(file));
  if (!(await lstat(candidate)).isFile())
    throw new CommunityApprovalError(
      'package file must be regular and cannot be a symlink',
    );
  const handle = await open(
    candidate,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    const { bytes } = COMMUNITY_MANIFEST_LIMITS;
    if (!stat.isFile())
      throw new CommunityApprovalError('package file must be regular');
    if (stat.size > bytes)
      throw new CommunityApprovalError('package exceeds the byte limit');
    const buffer = Buffer.alloc(bytes + 1);
    let offset = 0;
    while (offset <= bytes) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) return buffer.subarray(0, offset);
      offset += bytesRead;
    }
    throw new CommunityApprovalError('package exceeds the byte limit');
  } finally {
    await handle.close();
  }
}

function decodePackage(bytes: Uint8Array, approvedSha256?: string) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (approvedSha256 !== undefined && sha256 !== approvedSha256)
    throw new CommunityApprovalError(
      'SHA-256 does not match the approved checksum',
    );
  return { manifest: decodeCommunityManifest(bytes), sha256 };
}

export async function loadAuthorCommunityModule(root: string, file: string) {
  const { manifest, sha256 } = decodePackage(
    await readPackage(await realpath(root), file),
  );
  return {
    metadata: {
      file,
      providerKey: communityProviderKey(manifest),
      version: manifest.version,
      sha256,
      origin: manifest.origin,
    },
    module: compileCommunityManifest(manifest),
    credentialFields: Object.keys(manifest.connection?.fields ?? {}),
  };
}
