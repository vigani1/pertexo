# syntax=docker/dockerfile:1.7
FROM node:24.15.0-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:24.15.0-bookworm-slim AS production-dependencies
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
COPY . .
RUN pnpm install --prod --frozen-lockfile \
  && find apps packages -type d \( -name src -o -name test -o -name coverage \) -prune -exec rm -rf '{}' +

FROM node:24.15.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /workspace
RUN apt-get update \
  && apt-get install --no-install-recommends --yes tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 pertexo \
  && useradd --uid 10001 --gid pertexo --no-create-home --shell /usr/sbin/nologin pertexo
COPY --from=production-dependencies --chown=10001:10001 /workspace/node_modules ./node_modules
COPY --from=production-dependencies --chown=10001:10001 /workspace/apps ./apps
COPY --from=production-dependencies --chown=10001:10001 /workspace/packages ./packages
COPY --from=build --chown=10001:10001 /workspace/apps/api/dist ./apps/api/dist
COPY --from=build --chown=10001:10001 /workspace/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=10001:10001 /workspace/apps/lifecycle-command/dist ./apps/lifecycle-command/dist
COPY --from=build --chown=10001:10001 /workspace/apps/retention/dist ./apps/retention/dist
COPY --from=build --chown=10001:10001 /workspace/apps/recovery/dist ./apps/recovery/dist
COPY --from=build --chown=10001:10001 /workspace/packages/artifact-store/dist ./packages/artifact-store/dist
COPY --from=build --chown=10001:10001 /workspace/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=10001:10001 /workspace/packages/database/dist ./packages/database/dist
COPY --from=build --chown=10001:10001 /workspace/packages/integrations/dist ./packages/integrations/dist
COPY --from=build --chown=10001:10001 /workspace/packages/node-catalog/dist ./packages/node-catalog/dist
COPY --from=build --chown=10001:10001 /workspace/packages/node-sdk/dist ./packages/node-sdk/dist
COPY --from=build --chown=10001:10001 /workspace/packages/nodes-core/dist ./packages/nodes-core/dist
COPY --from=build --chown=10001:10001 /workspace/packages/observability/dist ./packages/observability/dist
COPY --from=build --chown=10001:10001 /workspace/packages/queue/dist ./packages/queue/dist
COPY --from=build --chown=10001:10001 /workspace/packages/workflow-engine/dist ./packages/workflow-engine/dist
COPY --from=build --chown=10001:10001 /workspace/packages/workflow-model/dist ./packages/workflow-model/dist
USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/main.js"]
