// Loaded with `node --import` into the real API and worker: the only change is
// that Slack's host, an outside service, answers from the test's recording sink.
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

const PROVIDER_HOST = 'slack.com';
// The HTTP client refuses private addresses before it connects; this one is
// never dialled, because the request below goes to the sink instead.
const PUBLIC_ADDRESS = '8.8.8.8';
const sink = new URL(process.env.PROVIDER_STAND_IN_ORIGIN);

const realLookup = dns.lookup;
dns.lookup = (hostname, ...rest) =>
  hostname === PROVIDER_HOST
    ? Promise.resolve([{ address: PUBLIC_ADDRESS, family: 4 }])
    : realLookup(hostname, ...rest);

const realRequest = https.request;
https.request = (url, options, callback) => {
  if (url.hostname !== PROVIDER_HOST)
    return realRequest(url, options, callback);
  const { lookup: _pinned, ...forwarded } = options;
  return http.request(new URL(url.pathname, sink), forwarded, callback);
};

syncBuiltinESMExports();
