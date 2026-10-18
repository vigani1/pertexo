import { z } from 'zod';
import type { FastifyRequest, FastifyReply } from 'fastify';
import {
  DirectoryError,
  DIRECTORY_LIMITS,
  type DirectoryPrincipal,
  type DirectoryStore,
  type DirectoryUser,
  type DirectoryGroup,
} from '@pertexo/database/tenant-access';
import { directoryDiscovery } from '../protocol/discovery.js';
import {
  parseDirectoryUser,
  parseDirectoryGroup,
  directoryUserDocument,
  directoryGroupDocument,
} from '../protocol/resources.js';
import { parseDirectoryPatch, applyDirectoryPatch } from '../protocol/patch.js';
import {
  parseDirectoryQuery,
  projectDirectoryDocument,
} from '../protocol/query.js';
import type { DirectoryResourceType } from '../protocol/core.js';

export function sendDirectoryDocument(
  reply: FastifyReply,
  document: unknown,
): void {
  const body = JSON.stringify(document);
  if (Buffer.byteLength(body) > DIRECTORY_LIMITS.responseBytes)
    throw new DirectoryError('limit');
  reply
    .type('application/scim+json')
    .header('cache-control', 'no-store')
    .send(body);
}
function expectedRevision(
  header: string | string[] | undefined,
  id: string,
): number | undefined {
  if (header === undefined || header === '*') return undefined;
  const match =
    typeof header === 'string'
      ? /^W\/"([a-f0-9-]{36}):([1-9][0-9]{0,9})"$/u.exec(header)
      : null;
  const revision = Number(match?.[2]);
  if (
    match?.[1] !== id ||
    !Number.isSafeInteger(revision) ||
    revision > 2147483647
  )
    throw new DirectoryError('stale');
  return revision;
}
export async function dispatchDirectoryRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  input: Readonly<{
    store: DirectoryStore;
    principal: DirectoryPrincipal;
    publicOrigin: string;
    path: string;
  }>,
): Promise<void> {
  const { store, principal, path } = input,
    base = `${input.publicOrigin}/v1/auth/federation/scim/${principal.organizationId}/v2`;
  if (request.method === 'GET') {
    const discovery = directoryDiscovery(path, base);
    if (discovery !== undefined) {
      sendDirectoryDocument(reply, discovery);
      return;
    }
  }
  const [collection, rawId, ...rest] = path.split('/');
  const kind: DirectoryResourceType =
    collection === 'Users'
      ? 'User'
      : collection === 'Groups'
        ? 'Group'
        : (() => {
            throw new DirectoryError('not_found');
          })();
  if (rest.length !== 0) throw new DirectoryError('not_found');
  const idResult = rawId === undefined ? undefined : z.uuid().safeParse(rawId);
  if (idResult !== undefined && !idResult.success)
    throw new DirectoryError('not_found');
  const id = idResult?.data;
  const { query, projection } = parseDirectoryQuery(request.query, kind);
  const revision =
    id === undefined
      ? undefined
      : expectedRevision(request.headers['if-match'], id);
  if (request.method === 'GET' && id === undefined) {
    const page =
      kind === 'User'
        ? await store.users(principal, query)
        : await store.groups(principal, query);
    const Resources = page.Resources.map((resource) =>
      projectDirectoryDocument(
        'user_name' in resource
          ? directoryUserDocument(resource, base)
          : directoryGroupDocument(resource, base),
        projection,
      ),
    );
    sendDirectoryDocument(reply, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: page.totalResults,
      startIndex: page.startIndex,
      itemsPerPage: Resources.length,
      Resources,
    });
    return;
  }
  if (request.method === 'DELETE' && id !== undefined) {
    if (kind === 'User') await store.deleteUser(principal, id, revision);
    else await store.deleteGroup(principal, id, revision);
    reply.code(204).send();
    return;
  }
  const body: unknown = request.body;
  let resource: DirectoryUser | DirectoryGroup | undefined;
  if (request.method === 'GET' && id !== undefined) {
    resource =
      kind === 'User'
        ? await store.user(principal, id)
        : await store.group(principal, id);
  } else if (request.method === 'POST' && id === undefined) {
    resource =
      kind === 'User'
        ? await store.createUser(principal, parseDirectoryUser(body))
        : await store.createGroup(principal, parseDirectoryGroup(body));
  } else if (request.method === 'PUT' && id !== undefined) {
    if (kind === 'User') {
      const values = parseDirectoryUser(body);
      resource = await store.changeUser(principal, id, revision, () => values);
    } else {
      const values = parseDirectoryGroup(body);
      resource = await store.changeGroup(principal, id, revision, () => values);
    }
  } else if (request.method === 'PATCH' && id !== undefined) {
    const operations = parseDirectoryPatch(body, kind);
    resource =
      kind === 'User'
        ? await store.changeUser(principal, id, revision, (current) =>
            parseDirectoryUser(
              applyDirectoryPatch(
                directoryUserDocument(current, base),
                operations,
              ),
            ),
          )
        : await store.changeGroup(principal, id, revision, (current) =>
            parseDirectoryGroup(
              applyDirectoryPatch(
                directoryGroupDocument(current, base),
                operations,
              ),
            ),
          );
  }
  if (resource === undefined) throw new DirectoryError('not_found');
  const document =
    'user_name' in resource
      ? directoryUserDocument(resource, base)
      : directoryGroupDocument(resource, base);
  reply
    .header('etag', document.meta.version)
    .header('location', document.meta.location);
  if (request.method === 'POST') reply.code(201);
  sendDirectoryDocument(reply, projectDirectoryDocument(document, projection));
}
