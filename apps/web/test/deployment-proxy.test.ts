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

  it('keeps API routes out of the SPA fallback and disables SSE buffering in production', async () => {
    const configuration = await readFile(
      new URL('../deployment/nginx.conf.template', import.meta.url),
      'utf8',
    );

    expect(configuration).toContain('location /v1');
    expect(configuration).toContain('proxy_pass ${PERTEXO_API_UPSTREAM};');
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
    expect(api.body).not.toContain('add_header');
    expect(configuration.slice(api.end)).toContain(
      'add_header X-Content-Type-Options "nosniff" always;',
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
