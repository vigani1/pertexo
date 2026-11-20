// The outside service HTTP steps call during the load: a slow, flaky API, a
// list API whose fresh pages a step fetches and Code transforms, and a receiver that calls a Wait back later, the way a payment
// or signing provider does. Compose interpolates `$`, so the source must not contain one.
export const FLAKY_FAILURE_SHARE = 0.15;
export const FLAKY_SLOW_SHARE = 0.15;
// About 40 KiB of JSON a page, under the HTTP step's 64 KiB response limit.
const PAGE_ITEMS = 500;

export const TARGET_SOURCE = `
const http = require('node:http');
const counts = { pages: 0, flaky: 0, served503: 0, slow: 0, callbacksAsked: 0, callbacksSent: 0, callbackStatuses: {} };
const answer = (response, status, body) => {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
};
function callBack(address, tries) {
  fetch(address, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'ready' }) })
    .then((response) => {
      counts.callbackStatuses[response.status] = (counts.callbackStatuses[response.status] || 0) + 1;
      if (response.status === 202) counts.callbacksSent++;
      else if ((response.status === 429 || response.status >= 500) && tries < 5) setTimeout(() => callBack(address, tries + 1), 5000);
    })
    .catch(() => {
      counts.callbackStatuses.network = (counts.callbackStatuses.network || 0) + 1;
      if (tries < 5) setTimeout(() => callBack(address, tries + 1), 5000);
    });
}
http.createServer((request, response) => {
  const url = new URL(request.url, 'http://target');
  if (url.pathname === '/counts') return answer(response, 200, counts);
  if (url.pathname === '/page') {
    counts.pages++;
    const items = Array.from({ length: ${PAGE_ITEMS} }, (unused, index) => ({
      id: index, sku: Math.random().toString(36).slice(2), price: Math.round(Math.random() * 10000) / 100,
      note: Math.random().toString(36).repeat(2),
    }));
    return answer(response, 200, { items, next: null });
  }
  if (url.pathname === '/flaky') {
    counts.flaky++;
    const roll = Math.random();
    if (roll < ${FLAKY_FAILURE_SHARE}) {
      counts.served503++;
      return answer(response, 503, { error: 'busy' });
    }
    const slow = roll < ${FLAKY_FAILURE_SHARE + FLAKY_SLOW_SHARE};
    if (slow) counts.slow++;
    return setTimeout(() => answer(response, 200, { ok: true }), slow ? 2000 + Math.random() * 3000 : 20);
  }
  if (url.pathname === '/callback') {
    counts.callbacksAsked++;
    const address = url.searchParams.get('callback');
    const delay = Number(url.searchParams.get('delay') || 1000);
    answer(response, 200, { scheduled: true });
    return setTimeout(() => callBack(address, 0), delay);
  }
  answer(response, 404, { error: 'not found' });
}).listen(8080);
`;
