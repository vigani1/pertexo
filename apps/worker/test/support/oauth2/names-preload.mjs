// Loaded with `node --import` into the real API and worker: the only change is
// that these names, which would need outside DNS, resolve where the test says.
// `route` hosts answer from the stand-in. So do `leak` hosts, under /leak/<host>,
// so a guard that lets one through shows there instead of dialling out. `dial`
// hosts really connect to the address they resolve to.
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

const hosts = JSON.parse(process.env.OAUTH2_TEST_HOSTS ?? '{}');
const sink = new URL(process.env.OAUTH2_TEST_SINK);

const realLookup = dns.lookup;
dns.lookup = (hostname, ...rest) => {
  const entry = hosts[hostname];
  return entry === undefined
    ? realLookup(hostname, ...rest)
    : Promise.resolve([{ address: entry.address, family: 4 }]);
};

const rerouted = (real) => (url, options, callback) => {
  const entry =
    url instanceof URL && typeof url.hostname === 'string'
      ? hosts[url.hostname]
      : undefined;
  if (entry === undefined || entry.via === 'dial')
    return real(url, options, callback);
  const { lookup: _pinned, ...forwarded } = options;
  const path = `${url.pathname}${url.search}`;
  return http.request(
    new URL(entry.via === 'leak' ? `/leak/${url.hostname}${path}` : path, sink),
    forwarded,
    callback,
  );
};
const realHttp = http.request;
const realHttps = https.request;
const routedHttp = rerouted(realHttp);
https.request = rerouted(realHttps);
// The rerouted call above is itself an http.request, to the sink, whose host is
// in no list, so it passes straight through.
http.request = routedHttp;

syncBuiltinESMExports();
