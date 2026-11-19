import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// What a workspace owner does under Settings → Single sign-on, through the
// same API the settings page calls. Every command names the revision it read.
const sso = (workspaceId) => `/v1/workspaces/${workspaceId}/sso`;

export async function readSettings(client, workspaceId) {
  const response = await client.get(sso(workspaceId));
  assert.equal(response.status, 200, response.text);
  return response.json;
}

const revisionOf = async (client, workspaceId) =>
  (await readSettings(client, workspaceId)).organization.revision;

async function command(client, workspaceId, method, path, body, status = 200) {
  const expectedRevision = await revisionOf(client, workspaceId);
  const response = await client[method](`${sso(workspaceId)}${path}`, {
    ...body,
    expectedRevision,
  });
  assert.equal(response.status, status, `${path}: ${response.text}`);
  return response.json;
}

/**
 * An identity organization controlled from `workspaceId`, with each domain
 * verified through DNS the way an owner publishes the shown TXT record, and
 * the control workspace open to the domains' people.
 */
export async function createOrganization(
  client,
  network,
  { workspaceId, name, domains },
) {
  const created = await client.post(`${sso(workspaceId)}/organization`, {
    name,
  });
  assert.equal(created.status, 201, created.text);
  const domainIds = {};
  for (const domain of domains) {
    const added = await command(
      client,
      workspaceId,
      'post',
      '/domains',
      { domain },
      201,
    );
    const entry = added.organization.domains.find(
      (candidate) => candidate.domain === domain,
    );
    await network.publishTxt(entry.challenge.recordName, entry.challenge.value);
    await command(
      client,
      workspaceId,
      'post',
      `/domains/${entry.id}/verify`,
      {},
    );
    domainIds[domain] = entry.id;
  }
  // People of the domains join the control workspace itself, as viewers.
  if (
    !(await readSettings(client, workspaceId)).organization.workspaces.some(
      (entry) => entry.workspaceId === workspaceId,
    )
  )
    await linkWorkspace(client, workspaceId, workspaceId, 'viewer');
  const settings = await readSettings(client, workspaceId);
  for (const domain of domains)
    assert.ok(
      settings.organization.domains.find((entry) => entry.domain === domain)
        .verifiedAt,
      `${domain} verified`,
    );
  return { organizationId: settings.organization.id, domainIds };
}

/** Lets people of the organization's domains join `targetWorkspaceId`. */
export const linkWorkspace = (client, workspaceId, targetWorkspaceId, role) =>
  command(client, workspaceId, 'post', '/workspaces', {
    workspaceId: targetWorkspaceId,
    defaultRole: role,
  });

const providerId = (settings, name) =>
  settings.organization.providers.find((provider) => provider.name === name).id;

export async function addOidcProvider(
  client,
  workspaceId,
  { name, issuer, clientId, secret, jit = true },
) {
  const settings = await command(
    client,
    workspaceId,
    'post',
    '/providers',
    {
      kind: 'oidc',
      name,
      issuer,
      configuration: { clientId, jitEnabled: jit },
      clientSecret: secret,
      enabled: true,
    },
    201,
  );
  return providerId(settings, name);
}

export async function addSamlProvider(
  client,
  workspaceId,
  {
    name,
    issuer,
    signInUrl,
    certificates,
    emailAttribute,
    nameAttribute,
    jit = true,
  },
) {
  const settings = await command(
    client,
    workspaceId,
    'post',
    '/providers',
    {
      kind: 'saml',
      name,
      issuer,
      configuration: {
        signInUrl,
        certificates,
        jitEnabled: jit,
        ...(emailAttribute ? { emailAttribute } : {}),
        ...(nameAttribute ? { nameAttribute } : {}),
      },
      enabled: true,
    },
    201,
  );
  return providerId(settings, name);
}

/** Replaces a SAML provider's certificates, as the rotation steps in the guide say. */
export async function replaceSamlCertificates(
  client,
  workspaceId,
  id,
  certificates,
) {
  const settings = await readSettings(client, workspaceId);
  const provider = settings.organization.providers.find(
    (candidate) => candidate.id === id,
  );
  return command(client, workspaceId, 'put', `/providers/${id}`, {
    kind: 'saml',
    name: provider.name,
    configuration: { ...provider.configuration, certificates },
    enabled: provider.enabled,
  });
}

export async function samlServiceProvider(client, workspaceId) {
  const response = await client.get(`${sso(workspaceId)}/saml/metadata`);
  assert.equal(response.status, 200, response.text);
  return response.json;
}

export async function members(client, workspaceId) {
  const response = await client.get(`/v1/workspaces/${workspaceId}/members`);
  assert.equal(response.status, 200, response.text);
  return response.json.items;
}

const directory = (workspaceId) => `${sso(workspaceId)}/directory`;

export async function readDirectory(client, workspaceId) {
  const response = await client.get(directory(workspaceId));
  assert.equal(response.status, 200, response.text);
  return response.json;
}

/** A provisioning bearer, shown once, as the credential dialog does. */
export async function createProvisioningCredential(client, workspaceId) {
  const { revision } = await readDirectory(client, workspaceId);
  const response = await client.post(`${directory(workspaceId)}/credentials`, {
    name: `Directory ${randomUUID().slice(0, 8)}`,
    expectedRevision: revision,
  });
  assert.equal(response.status, 201, response.text);
  return response.json.secret;
}

export async function replaceMappings(client, workspaceId, mappings) {
  const { revision } = await readDirectory(client, workspaceId);
  const response = await client.put(`${directory(workspaceId)}/mappings`, {
    expectedRevision: revision,
    mappings,
  });
  assert.ok(response.status < 300, response.text);
}

export async function directoryPeople(client, workspaceId) {
  const response = await client.get(
    `${directory(workspaceId)}/people?limit=100`,
  );
  assert.equal(response.status, 200, response.text);
  return response.json.items;
}
