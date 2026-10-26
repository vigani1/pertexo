import { scenario } from '../fixture/environment.js';
import {
  emailDeliveries,
  fixtureState,
  noticeMessages,
} from '../fixture/state.js';
import type { EditorControlRequest } from './contract.js';

export function handleEditorOidcMetadata(input: EditorControlRequest): boolean {
  const { request, response, url, context } = input;
  const { fixture } = context;
  if (
    scenario === 'organization-oidc' &&
    request.method === 'GET' &&
    url.pathname === '/organization-provider' &&
    fixture.oidcProvider !== undefined
  ) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ issuer: fixture.oidcProvider.origin }));
    return true;
  }
  return false;
}

export function handleEditorCuratedSeed(input: EditorControlRequest): boolean {
  const { request, response, url } = input;
  if (
    request.method === 'GET' &&
    url.pathname === '/curated-template-seed' &&
    scenario === 'curated-templates' &&
    fixtureState.curatedFixture !== undefined
  ) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(fixtureState.curatedFixture.scope));
    return true;
  }
  return false;
}

export function handleEditorPortabilitySeed(
  input: EditorControlRequest,
): boolean {
  const { request, response, url } = input;
  if (
    request.method === 'GET' &&
    url.pathname === '/workflow-portability-seed' &&
    scenario === 'portability' &&
    fixtureState.portabilityFixture !== undefined
  ) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(fixtureState.portabilityFixture.scope));
    return true;
  }
  return false;
}

export function handleEditorVerificationLink(
  input: EditorControlRequest,
): boolean {
  const { request, response, url, context } = input;
  const { api } = context;
  if (request.method === 'GET' && url.pathname === '/verification') {
    try {
      const link = api.mailedLink(
        url.searchParams.get('email') ?? '',
        'verification',
      );
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ path: link.pathname + link.search }));
    } catch {
      response.writeHead(404).end();
    }
    return true;
  }
  return false;
}

/** The emails the worker's Resend stand-in accepted, for the journey to read. */
export function handleEditorEmailDeliveries(
  input: EditorControlRequest,
): boolean {
  const { request, response, url } = input;
  if (
    request.method !== 'GET' ||
    url.pathname !== '/email-deliveries' ||
    scenario !== 'email-attachments'
  )
    return false;
  response
    .writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    })
    .end(JSON.stringify({ emails: emailDeliveries }));
  return true;
}

export function handleEditorNoticeMail(input: EditorControlRequest): boolean {
  const { request, response, url } = input;
  if (
    request.method === 'GET' &&
    url.pathname === '/notice-mail' &&
    scenario === 'notifications'
  ) {
    response
      .writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      })
      .end(JSON.stringify({ messages: noticeMessages }));
    return true;
  }
  return false;
}
