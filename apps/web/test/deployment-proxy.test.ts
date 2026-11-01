// @vitest-environment node

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import viteConfig from '../vite.config';

describe('same-origin web proxy configuration', () => {
  it('preserves /v1 through the development proxy without changing origin headers', () => {
    const proxy = viteConfig.server?.proxy?.['/v1'];

    expect(proxy).toMatchObject({
      target: 'http://127.0.0.1:3000',
      changeOrigin: false,
    });
  });

  // S8: `access_log off` leaves the error log, which writes the code and state
  // from the callback's query whenever the API is away.
  it.fails(
    'S8 keeps the OAuth2 callback out of nginx error logs too',
    async () => {
      const configuration = await readFile(
        new URL('../deployment/nginx.conf.template', import.meta.url),
        'utf8',
      );
      const start = configuration.indexOf(
        'location = /v1/connections/oauth2/callback {',
      );
      expect(start).toBeGreaterThan(-1);
      const block = configuration.slice(
        start,
        configuration.indexOf('\n  }', start),
      );
      expect(block).toContain('access_log off;');
      expect(block).toContain('error_log /dev/null crit;');
    },
  );

  it('keeps API routes out of the SPA fallback and disables SSE buffering in production', async () => {
    const configuration = await readFile(
      new URL('../deployment/nginx.conf.template', import.meta.url),
      'utf8',
    );

    expect(configuration).toContain('location /v1');
    expect(configuration).toContain(
      'set $pertexo_api_upstream ${PERTEXO_API_UPSTREAM};',
    );
    expect(configuration).toContain('proxy_pass $pertexo_api_upstream;');
    expect(configuration).toContain('proxy_set_header Connection "";');
    expect(configuration).toContain('proxy_buffering off;');
    expect(configuration).toContain('proxy_cache off;');
    expect(configuration).toContain('try_files $uri $uri/ /index.html;');
    expect(configuration.indexOf('location /v1')).toBeLessThan(
      configuration.indexOf('location / {'),
    );
  });

  it('sets effective security and cache headers for both static response locations', async () => {
    const configuration = await readFile(
      new URL('../deployment/nginx.conf.template', import.meta.url),
      'utf8',
    );
    const assets = nginxBlock(configuration, 'location /assets/');
    const spa = nginxBlock(configuration, 'location / {');
    const api = nginxBlock(configuration, 'location /v1');

    expect(assets.body).toContain(
      'add_header Cache-Control "public, max-age=31536000, immutable" always;',
    );
    expect(spa.body).toContain('add_header Cache-Control "no-cache" always;');
    for (const staticLocation of [assets.body, spa.body]) {
      expect(staticLocation).toContain(
        'add_header X-Content-Type-Options "nosniff" always;',
      );
      expect(staticLocation).toContain(
        'add_header Referrer-Policy "strict-origin-when-cross-origin" always;',
      );
    }
    // Pages can't be framed by another site.
    expect(spa.body).toContain("frame-ancestors 'none'");
    // nginx drops inherited lines per block, so each block has its own copy.
    expect(
      new Set(
        [
          ...configuration.matchAll(/add_header Content-Security-Policy .*/gu),
        ].map(([line]) => line),
      ).size,
    ).toBe(1);
    expect(spa.body).toContain('add_header X-Frame-Options "DENY" always;');
    expect(api.body).not.toContain('add_header');
    expect(configuration.slice(api.end)).toContain(
      'add_header X-Content-Type-Options "nosniff" always;',
    );
  });

  it('compresses the app files and passes API responses through as sent', async () => {
    const configuration = await readFile(
      new URL('../deployment/nginx.conf.template', import.meta.url),
      'utf8',
    );
    const server = nginxBlock(configuration, 'server {').body;
    const shared = server.slice(0, server.indexOf('location '));
    expect(shared).toContain('gzip on;');
    // Caddy and load balancers forward requests; nginx skips those by default.
    expect(shared).toContain('gzip_proxied any;');
    expect(shared).toMatch(/gzip_types [^;]*application\/javascript/u);
    expect(shared).toMatch(/gzip_types [^;]*text\/css/u);
    expect(nginxBlock(configuration, 'location /v1').body).toContain(
      'gzip off;',
    );
  });

  it('retains a trusted proxy scheme and falls back to the direct scheme', async () => {
    const configuration = await readFile(
      new URL('../deployment/nginx.conf.template', import.meta.url),
      'utf8',
    );
    const mapping = nginxBlock(configuration, 'map $http_x_forwarded_proto');
    expect(mapping.body).toContain('default $scheme;');
    expect(mapping.body).toContain('http http;');
    expect(mapping.body).toContain('https https;');
    expect(nginxBlock(configuration, 'location /v1').body).toContain(
      'proxy_set_header X-Forwarded-Proto $pertexo_forwarded_proto;',
    );
  });
});

function nginxBlock(source: string, marker: string) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing Nginx block: ${marker}`);
  const opening = source.indexOf('{', start);
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] !== '}') continue;
    depth -= 1;
    if (depth === 0)
      return { body: source.slice(opening + 1, index), end: index };
  }
  throw new Error(`Unclosed Nginx block: ${marker}`);
}
