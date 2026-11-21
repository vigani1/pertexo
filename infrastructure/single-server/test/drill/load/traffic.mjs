import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { HEALTHY } from '../support/code-attacks.mjs';
import {
  deliverWebhook,
  edge,
  node,
  provisionWebhook,
  publishWorkflow,
} from '../support/product.mjs';
import { TARGET_ORIGIN } from './stack.mjs';

// What people and outside systems do to the product during the load, through
// its public HTTP surface only. Every request is written to a ledger; the
// observer later checks the ledger against the database.

const port = (id, source, sourcePort, target) => ({
  id,
  source: { nodeId: source, port: sourcePort },
  target: { nodeId: target, port: 'in' },
});
// A flaky API is worth a few tries; the ceiling is the product's own.
const HTTP_RETRY = { maximumAttempts: 5, delayMillis: 1_000 };
// The answers are small JSON; nothing redirects.
const HTTP_LIMITS = {
  timeoutMillis: 10_000,
  maxRedirects: 0,
  maxResponseBytes: 65_536,
  inlineResponseBytes: 65_536,
};
const CALLBACK_DELAY_MILLIS = 5_000;
const WAIT_SECONDS = 60;
const INLINE_SET_VERSION = 2;

/** The workflows a small team runs, published in one workspace. */
export async function publishTeamWorkflows(client, workspaceId) {
  const publish = (name, nodes, edges) =>
    publishWorkflow(client, workspaceId, {
      name,
      nodes: nodes.map((step) =>
        step.definition.key === 'core.set'
          ? {
              ...step,
              definition: { ...step.definition, version: INLINE_SET_VERSION },
            }
          : step,
      ),
      edges,
    });
  const hook = async (name, nodes, edges) =>
    provisionWebhook(client, await publish(name, nodes, edges));
  const manual = (name, nodes, edges) =>
    publish(
      name,
      [node('start', 'core.manual'), ...nodes],
      [edge('first', 'start', nodes[0].id), ...edges],
    );
  return {
    codeHook: await hook(
      'Webhook Code',
      [
        node('hook', 'core.webhook'),
        node('code', 'core.code', { code: HEALTHY.javascript }),
      ],
      [edge('first', 'hook', 'code')],
    ),
    httpHook: await hook(
      'Webhook HTTP',
      [
        node('hook', 'core.webhook'),
        {
          ...node('call', 'http.request', {
            method: 'GET',
            url: `${TARGET_ORIGIN}/flaky`,
            headers: {},
            ...HTTP_LIMITS,
          }),
          retry: HTTP_RETRY,
        },
      ],
      [edge('first', 'hook', 'call')],
    ),
    python: await manual(
      'Python',
      [node('code', 'core.code', { code: HEALTHY.python, language: 'python' })],
      [],
    ),
    timedWait: await manual(
      'Timed wait',
      [
        node('wait', 'core.wait', { durationSeconds: WAIT_SECONDS }),
        node('after', 'core.set', {}, { value: { kind: 'literal', value: 1 } }),
      ],
      [edge('second', 'wait', 'after')],
    ),
    approval: await manual(
      'Approval',
      [
        node('approve', 'core.approval', {
          title: 'Load approval',
          allowStarterToDecide: true,
        }),
        node('after', 'core.set', {}, { value: { kind: 'literal', value: 1 } }),
      ],
      [port('second', 'approve', 'approved', 'after')],
    ),
    callback: await manual(
      'Callback',
      [
        {
          ...node(
            'ask',
            'http.request',
            {
              method: 'GET',
              url: `${TARGET_ORIGIN}/callback?delay=${CALLBACK_DELAY_MILLIS}&callback={callbackUrl}`,
              headers: {},
              ...HTTP_LIMITS,
            },
            {
              callbackUrl: {
                kind: 'expression',
                language: 'jsonata',
                expression: '$lookup($execution.callbacks,"wait").url',
              },
            },
          ),
          retry: HTTP_RETRY,
        },
        node('wait', 'core.wait', { mode: 'callback', timeoutSeconds: 600 }),
      ],
      [edge('second', 'ask', 'wait')],
    ),
    schedule: await publish(
      'Every minute',
      [
        node('tick', 'core.schedule', {
          kind: 'interval',
          intervalMinutes: 1,
          misfirePolicy: 'catch_up_once',
        }),
        node('after', 'core.set', {}, { value: { kind: 'literal', value: 1 } }),
      ],
      [edge('first', 'tick', 'after')],
    ),
  };
}

// Code that reads every item of a fetched page, as a real transform does.
const TRANSFORM = {
  javascript:
    'const text = JSON.stringify(input); let total = 0; for (const match of text.matchAll(/"price":([0-9.]+)/g)) total += Number(match[1]); return { bytes: text.length, total };',
  python:
    'import json, re\ntext = json.dumps(input)\nreturn {"bytes": len(text), "total": sum(float(price) for price in re.findall(r\'"price": ([0-9.]+)\', text))}',
};

/**
 * The worker's heaviest everyday work: a webhook fetches a page of about
 * 40 KiB from an outside API and Code transforms it, in JavaScript or Python.
 */
export async function publishFetchAndTransformHooks(client, workspaceId) {
  const hooks = {};
  for (const language of ['javascript', 'python'])
    hooks[language] = await provisionWebhook(
      client,
      await publishWorkflow(client, workspaceId, {
        name: `Fetch and transform (${language})`,
        nodes: [
          node('hook', 'core.webhook'),
          {
            ...node('fetch', 'http.request', {
              method: 'GET',
              url: `${TARGET_ORIGIN}/page`,
              headers: {},
              ...HTTP_LIMITS,
            }),
            retry: HTTP_RETRY,
          },
          node(
            'transform',
            'core.code',
            { code: TRANSFORM[language], language },
            { page: { kind: 'node_output', nodeId: 'fetch', path: '$' } },
          ),
        ],
        edges: [
          edge('first', 'hook', 'fetch'),
          edge('second', 'fetch', 'transform'),
        ],
      }),
    );
  return hooks;
}

/** The cheapest webhook workflow: nothing but the run itself. */
export async function publishLightHook(client, workspaceId) {
  return provisionWebhook(
    client,
    await publishWorkflow(client, workspaceId, {
      name: 'Webhook only',
      nodes: [
        node('hook', 'core.webhook'),
        node('after', 'core.set', {}, { value: { kind: 'literal', value: 1 } }),
      ],
      edges: [edge('first', 'hook', 'after')],
    }),
  );
}

/**
 * Everything the driver asked for and what it got back. `requests` is every
 * call; `runs` every run the product said it accepted, by id.
 */
export function createLedger() {
  const requests = [];
  const runs = new Map();
  const eventRuns = new Map();
  return {
    requests,
    runs,
    eventRuns,
    request(kind, started, response, error) {
      const entry = {
        kind,
        at: started,
        millis: Date.now() - started,
        status: response?.status ?? (error ? 'error' : 'none'),
      };
      if (error) entry.error = String(error.message ?? error).slice(0, 200);
      if (response && response.status >= 400)
        entry.problem = (response.json?.code ?? response.text ?? '').slice(
          0,
          200,
        );
      if (response?.headers?.['retry-after'])
        entry.retryAfter = response.headers['retry-after'];
      requests.push(entry);
      return entry;
    },
    run(runId, kind, workspaceId, eventId) {
      if (!runs.has(runId))
        runs.set(runId, { kind, workspaceId, at: Date.now() });
      if (eventId) {
        const seen = eventRuns.get(eventId) ?? new Set();
        seen.add(runId);
        eventRuns.set(eventId, seen);
      }
    },
  };
}

const running = new Set();

/** Stops every sender still running, so a failed scenario still ends. */
export const stopAllTraffic = () =>
  Promise.all([...running].map((loop) => loop.stop()));

/** Starts `send` every `millis` (±jitter) without waiting for it, until stopped. */
export function pace(millis, send, { jitter = 0.3, inFlight } = {}) {
  let stopped = false;
  const pending = new Set();
  const loop = (async () => {
    while (!stopped) {
      if (inFlight === undefined || pending.size < inFlight) {
        const sending = Promise.resolve()
          .then(send)
          // Senders record what the product answered; a throw is the driver's own bug.
          .catch((error) => console.error('A load sender failed:', error))
          .finally(() => pending.delete(sending));
        pending.add(sending);
      }
      const spread = millis * jitter * (Math.random() * 2 - 1);
      await sleep(Math.max(0, millis + spread));
    }
  })();
  const handle = {
    pending,
    async stop() {
      stopped = true;
      running.delete(handle);
      await loop;
      await Promise.all(pending);
    },
  };
  running.add(handle);
  return handle;
}

export const sleep = (millis) =>
  new Promise((resolve) => setTimeout(resolve, millis));

/**
 * One signed delivery. A share of senders retry the same event a moment later,
 * as real senders do after a lost answer; both answers must name one run.
 */
export async function sendDelivery(
  ledger,
  client,
  kind,
  workspaceId,
  webhook,
  { resendShare = 0, timeout } = {},
) {
  const eventId = randomUUID();
  const deliver = async (what) => {
    const started = Date.now();
    try {
      const response = await deliverWebhook(client, webhook, {
        eventId,
        timeout,
      });
      ledger.request(what, started, response);
      if (response.status === 202 && response.json?.runId)
        ledger.run(response.json.runId, kind, workspaceId, eventId);
      return response;
    } catch (error) {
      ledger.request(what, started, undefined, error);
      return undefined;
    }
  };
  const first = await deliver(kind);
  // A sender that heard nothing must retry, or the event may be lost.
  if (first === undefined || Math.random() < resendShare) {
    await sleep(1_000 + Math.random() * 4_000);
    await deliver(`${kind} resend`);
  }
}

/** A person pressing Run on a published workflow. */
export async function startManualRun(ledger, client, kind, workflow) {
  const started = Date.now();
  try {
    const response = await client.post(`${workflow}/runs`, { input: null });
    ledger.request(kind, started, response);
    if (response.status === 202)
      ledger.run(response.json.run.id, kind, workflow.split('/')[3], undefined);
  } catch (error) {
    ledger.request(kind, started, undefined, error);
  }
}

/** Uploads a file through the presigned address, then reads it back. */
export async function uploadAndCheck(ledger, client, workspaceId) {
  const bytes = randomBytes(1_024 + Math.floor(Math.random() * 512 * 1_024));
  const artifacts = `/v1/workspaces/${workspaceId}/artifacts`;
  const step = async (kind, call) => {
    const started = Date.now();
    try {
      const response = await call();
      ledger.request(kind, started, response);
      return response.status < 300 ? response : undefined;
    } catch (error) {
      ledger.request(kind, started, undefined, error);
      return undefined;
    }
  };
  const begun = await step('upload begin', () =>
    client.post(`${artifacts}/uploads`, {
      byteLength: bytes.length,
      mediaType: 'application/octet-stream',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }),
  );
  if (!begun) return;
  const { artifact, upload } = begun.json;
  const stored = await step('upload transfer', () =>
    client.anonymous(upload.method, upload.url, bytes, upload.headers, 60_000),
  );
  if (!stored) return;
  if (
    !(await step('upload finalize', () =>
      client.post(`${artifacts}/${artifact.id}/finalize`, {}),
    ))
  )
    return;
  const link = await step('download link', () =>
    client.get(`${artifacts}/${artifact.id}/download`),
  );
  if (!link) return;
  const file = await step('download', () =>
    client.anonymous('GET', link.json.url, undefined, undefined, 60_000),
  );
  if (file && !file.bytes.equals(bytes))
    ledger.request('download mismatch', Date.now(), { status: 'corrupt' });
}

/** Approves every pending approval it can see, as an approver working an inbox. */
export async function approvePending(ledger, client, workspaceId) {
  const base = `/v1/workspaces/${workspaceId}/pending-tasks`;
  const started = Date.now();
  let listed;
  try {
    listed = await client.get(`${base}?view=all&kind=approval`);
    ledger.request('approvals list', started, listed);
  } catch (error) {
    ledger.request('approvals list', started, undefined, error);
    return;
  }
  for (const task of listed.json?.items ?? []) {
    const decided = Date.now();
    try {
      const response = await client.post(`${base}/${task.id}/decide`, {
        decision: 'approved',
      });
      ledger.request('approval decide', decided, response);
    } catch (error) {
      ledger.request('approval decide', decided, undefined, error);
    }
  }
}

/**
 * A person with the app open: the page itself, the run history, one run's
 * page, the workflow list and the inbox, read the way the screens read them.
 */
export async function browse(ledger, client, workspaceId) {
  const workspace = `/v1/workspaces/${workspaceId}`;
  const read = async (kind, target) => {
    const started = Date.now();
    try {
      const response = await client.get(target);
      ledger.request(kind, started, response);
      return response;
    } catch (error) {
      ledger.request(kind, started, undefined, error);
      return undefined;
    }
  };
  const page = await read('page', '/');
  const script = /src="(\/assets\/[^"]+\.js)"/u.exec(page?.text ?? '')?.[1];
  if (script) await read('page asset', script);
  const history = await read('run history', `${workspace}/runs?limit=25`);
  const items = history?.json?.items ?? history?.json?.runs ?? [];
  const run = items[Math.floor(Math.random() * items.length)];
  if (run) await read('run page', `${workspace}/runs/${run.id}`);
  await read('workflow list', `${workspace}/workflows`);
  await read('inbox', `${workspace}/pending-tasks`);
}
