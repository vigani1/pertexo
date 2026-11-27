# Pertexo web

The React and Vite client for Pertexo. See the
[project README](../../README.md#what-it-supports) and
[user guides](../../docs/guides/README.md) for supported features.

## Run and verify

From the repository root, follow
[local development](../../README.md#local-development) for Node and pnpm setup,
then run `pnpm dev` to start the full stack. `pnpm dev:web` starts just the
frontend when the backend is already running.

Vite serves `http://127.0.0.1:5173` and proxies `/v1` and `/hooks` to
`http://127.0.0.1:3000` by default. Set `PERTEXO_API_PROXY_TARGET` for a
different backend origin.

```sh
pnpm --filter @pertexo/web build
pnpm --filter @pertexo/web lint
pnpm --filter @pertexo/web test
pnpm --filter @pertexo/web exec playwright install chromium
pnpm --filter @pertexo/web test:e2e
```

`test:e2e` builds the required workspace packages and starts an isolated preview
with a mocked API. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` if using an
existing Chromium or Chrome. Tests against the real stack use the
[live browser runner](../../infrastructure/testing/run-browser-journeys.mjs)
with a test-owned Compose project and service ports.

## Working on the frontend

- [Web workspace rules](AGENTS.md) own layout, imports, configuration and
  checks.
- [Frontend architecture](ARCHITECTURE.md) explains browser state, save and run
  protocols, and [Weft](ARCHITECTURE.md#weft-design-system).
- Settings → Account → Appearance sets System, Light or Dark for this browser.
  See the [appearance plan](../../docs/feature-plans/36-light-theme.md) for how
  the preference is applied and stored.

The production build writes `dist/`. The
[nginx template](deployment/nginx.conf.template) handles the API proxy, hashed
assets and browser routes. `PERTEXO_API_UPSTREAM` is the internal API origin
without a path. See the
[single-server runbook](../../docs/operations/single-server.md) for deployment.
