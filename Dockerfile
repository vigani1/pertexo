# syntax=docker/dockerfile:1.7
FROM node:24.18.1-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:24.18.1-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS production-dependencies
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
COPY . .
RUN pnpm install --prod --frozen-lockfile \
  && find apps packages -type d \( -name src -o -name test -o -name coverage \) -prune -exec rm -rf '{}' +

# Vendor package hashes come from Debian's signed Bookworm security metadata.
FROM scratch AS runtime-security-patches
ADD --checksum=sha256:d2f7edfcc7689b9e0761c2742cc824ac86a20768bc5e8057818dc6875291fe76 https://deb.debian.org/debian-security/pool/updates/main/p/pcre2/libpcre2-8-0_10.42-1+deb12u2_amd64.deb /amd64.deb
ADD --checksum=sha256:8498d2c0bd6747dfc2fc6eec62774a86967079555f7043d5a7b78ee4efbbc0fb https://deb.debian.org/debian-security/pool/updates/main/p/pcre2/libpcre2-8-0_10.42-1+deb12u2_arm64.deb /arm64.deb
ADD --checksum=sha256:d7d1943aec9597629bf73075efcc5ef6dc9bda96d78e80d843156ecd448478b8 https://deb.debian.org/debian-security/pool/updates/main/p/perl/perl-base_5.36.0-7+deb12u4_amd64.deb /perl-amd64.deb
ADD --checksum=sha256:03d979b849a1a0a8955eee28b988dbc25a407fd3a0581df5c94e6ae7bcc01ddf https://deb.debian.org/debian-security/pool/updates/main/p/perl/perl-base_5.36.0-7+deb12u4_arm64.deb /perl-arm64.deb

FROM node:24.18.1-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS runtime
ENV NODE_ENV=production
WORKDIR /workspace
# Debian's PCRE2 and Perl security fixes postdate the pinned Node base.
RUN --mount=type=bind,from=runtime-security-patches,target=/security-patches \
  dpkg --install "/security-patches/$(dpkg --print-architecture).deb" \
    "/security-patches/perl-$(dpkg --print-architecture).deb" \
  && test "$(dpkg-query --show --showformat='${Version}' perl-base)" = '5.36.0-7+deb12u4'
RUN rm -rf /usr/local/lib/node_modules/corepack /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/pnpm /usr/local/bin/pnpx \
  && groupadd --gid 10001 pertexo \
  && useradd --uid 10001 --gid pertexo --no-create-home --shell /usr/sbin/nologin pertexo
COPY --from=production-dependencies --chown=10001:10001 /workspace/node_modules ./node_modules
COPY --from=production-dependencies --chown=10001:10001 /workspace/apps ./apps
COPY --from=production-dependencies --chown=10001:10001 /workspace/packages ./packages
COPY --from=build --chown=10001:10001 /workspace/apps/api/dist ./apps/api/dist
COPY --from=build --chown=10001:10001 /workspace/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=10001:10001 /workspace/apps/ops/dist ./apps/ops/dist
COPY --from=build --chown=10001:10001 /workspace/packages/artifact-store/dist ./packages/artifact-store/dist
COPY --from=build --chown=10001:10001 /workspace/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=10001:10001 /workspace/packages/database/dist ./packages/database/dist
COPY --from=build --chown=10001:10001 /workspace/packages/integrations/dist ./packages/integrations/dist
COPY --from=build --chown=10001:10001 /workspace/packages/node-catalog/dist ./packages/node-catalog/dist
COPY --from=build --chown=10001:10001 /workspace/packages/node-sdk/dist ./packages/node-sdk/dist
COPY --from=build --chown=10001:10001 /workspace/packages/nodes-core/dist ./packages/nodes-core/dist
COPY --from=build --chown=10001:10001 /workspace/packages/observability/dist ./packages/observability/dist
COPY --from=build --chown=10001:10001 /workspace/packages/queue/dist ./packages/queue/dist
COPY --from=build --chown=10001:10001 /workspace/packages/rate-limit/dist ./packages/rate-limit/dist
COPY --from=build --chown=10001:10001 /workspace/packages/workflow-engine/dist ./packages/workflow-engine/dist
COPY --from=build --chown=10001:10001 /workspace/packages/workflow-model/dist ./packages/workflow-model/dist
USER 10001:10001
CMD ["node", "apps/api/dist/main.js"]
