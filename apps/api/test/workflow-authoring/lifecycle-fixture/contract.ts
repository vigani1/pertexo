import type { Role } from '@pertexo/workflow-model';

import type { IdentityWorkspaceStore } from '@pertexo/core/testing';
import type { WorkspaceDatabase } from '@pertexo/database/testing';

import type { createApiApplication } from '../../../src/app.js';

import type { PoolClient } from 'pg';

import type { HttpSessionCookies } from '../../webhooks/support/browser-session.fixture.js';

export // Only these fixture accounts are provisioned.
type LifecycleFixtureRole = Exclude<Role, 'admin'>;

export type SessionCookies = HttpSessionCookies;

export type LifecycleWorkflowIds = Readonly<{
  unpublished: string;
  published: string;
  publishedVersion: string;
  run: string;
}>;

export type WorkflowHistory = Readonly<{
  draft: Readonly<{
    revision: number;
    graph: unknown;
  }>;
  versions: readonly Readonly<{
    id: string;
    checksum: string;
    graph: unknown;
    versionNumber: number;
  }>[];
  runs: readonly Readonly<{
    id: string;
    status: string;
    workflowVersionId: string;
  }>[];
}>;

export type WorkflowLifecycleState = Readonly<{
  lifecycleStatus: 'active' | 'archived';
  lifecycleRevision: number;
  activationStatus:
    | 'inactive'
    | 'activating'
    | 'active'
    | 'deactivating'
    | 'degraded'
    | 'error';
  publishedVersionId: string | null;
}>;

export type WorkflowLifecycleApiFixture = Readonly<{
  application: Awaited<ReturnType<typeof createApiApplication>>;
  workspaceDatabase: WorkspaceDatabase;
  identityDatabase: IdentityWorkspaceStore;
  workspaceId: string;
  ownerUserId: string;
  builderUserId: string;
  operatorUserId: string;
  viewerUserId: string;
  ids: LifecycleWorkflowIds;
  login(subject: LifecycleFixtureRole): Promise<SessionCookies>;
  withOwner<T>(work: (client: PoolClient) => Promise<T>): Promise<T>;
  setWorkspaceStatus(
    status: 'active' | 'suspended' | 'pending_deletion',
  ): Promise<void>;
  readLifecycle(workflowId: string): Promise<WorkflowLifecycleState>;
  readHistory(workflowId: string): Promise<WorkflowHistory>;
  createForeignVersion(): Promise<string>;
  close(): Promise<void>;
}>;
