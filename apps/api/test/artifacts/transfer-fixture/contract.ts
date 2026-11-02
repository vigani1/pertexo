import type { Role } from '@pertexo/workflow-model';

import type {
  ArtifactDownloadCapability,
  ArtifactStore,
} from '@pertexo/artifact-store';
import type { IdentityWorkspaceStore } from '@pertexo/core/testing';
import type { WorkspaceDatabase } from '@pertexo/database/testing';
import type { StructuredLogger } from '@pertexo/observability';
import type { PoolClient } from 'pg';

import type { createApiApplication } from '../../../src/app.js';

import type { HttpSessionCookies } from '../../webhooks/support/browser-session.fixture.js';

export // Only these fixture accounts are provisioned.
type ArtifactFixtureRole = Exclude<Role, 'admin' | 'builder'>;

export type SessionCookies = HttpSessionCookies;

export type ArtifactRequestMetadata = Readonly<{
  byteLength: number;
  mediaType: string;
  sha256: string;
}>;

export type ArtifactRecordSnapshot = Readonly<{
  id: string;
  workspaceId: string;
  purpose: string;
  storageKey: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  status: string;
  expiresAt: Date;
  finalizedAt: Date | null;
  deletedAt: Date | null;
}>;

export type ArtifactCapacitySnapshot = Readonly<{
  byteLimit: number;
  artifactCountLimit: number;
  chargedBytes: number;
  chargedCount: number;
}>;

export type VerificationStore = ArtifactStore & ArtifactDownloadCapability;

export type ArtifactStorageCallSnapshot = Readonly<{
  beginDirectDownload: number;
  beginDirectUpload: number;
  validateDirectUpload: number;
}>;

export type ArtifactTransferApiFixture = Readonly<{
  application: Awaited<ReturnType<typeof createApiApplication>>;
  workspaceDatabase: WorkspaceDatabase;
  identityDatabase: IdentityWorkspaceStore;
  workspaceId: string;
  otherWorkspaceId: string;
  ownerUserId: string;
  operatorUserId: string;
  viewerUserId: string;
  verificationStore: VerificationStore;
  afterNextUploadVerification(callback: () => Promise<void>): void;
  readDurableTransferEvidence(artifactId: string): Promise<readonly string[]>;
  readLogText(): string;
  readStorageCalls(): ArtifactStorageCallSnapshot;
  login(subject: ArtifactFixtureRole): Promise<SessionCookies>;
  withOwner<T>(work: (client: PoolClient) => Promise<T>): Promise<T>;
  withApi<T>(work: (client: PoolClient) => Promise<T>): Promise<T>;
  setCapacity(
    input: Readonly<{
      byteLimit: number;
      artifactCountLimit: number;
    }>,
  ): Promise<void>;
  setWorkspaceStatus(
    status: 'active' | 'suspended' | 'pending_deletion',
  ): Promise<void>;
  readCapacity(): Promise<ArtifactCapacitySnapshot>;
  readArtifact(artifactId: string): Promise<ArtifactRecordSnapshot | null>;
  expireArtifact(artifactId: string): Promise<void>;
  close(): Promise<void>;
}>;

export type FixtureLogCapture = Readonly<{
  logger: StructuredLogger;
  readText(): string;
}>;
