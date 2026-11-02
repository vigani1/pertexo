# syntax=docker/dockerfile:1.7
FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
RUN apt-get update && apt-get install --yes --no-install-recommends gcc libc6-dev linux-libc-dev \
  && rm -rf /var/lib/apt/lists/*
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build \
  && gcc -std=c11 -Wall -Wextra -Werror -O2 -fstack-protector-strong -fPIE -pie \
    -D_FORTIFY_SOURCE=3 -Wl,-z,relro,-z,now \
    -o apps/code-runner/dist/launch apps/code-runner/native/launch.c

FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS python-build
RUN apt-get update && apt-get install --yes --no-install-recommends \
    gcc make xz-utils libc6-dev libssl-dev zlib1g-dev libffi-dev libbz2-dev liblzma-dev \
  && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:673ae7232d84c894729882c8257d300ef2d26523911bfd3917ec8ce7f526f99b https://www.python.org/ftp/python/3.15.1/Python-3.15.1.tar.xz /tmp/python.tar.xz
RUN mkdir /tmp/python && tar -xf /tmp/python.tar.xz -C /tmp/python --strip-components=1 \
  && cd /tmp/python \
  && ./configure --prefix=/opt/pertexo-python --without-ensurepip --disable-test-modules \
  && make -j2 && make install \
  && rm -rf /opt/pertexo-python/lib/python3.15/ensurepip \
    /opt/pertexo-python/include /opt/pertexo-python/share \
    /opt/pertexo-python/lib/pkgconfig /opt/pertexo-python/lib/libpython3.15.a \
    /opt/pertexo-python/lib/python3.15/config-* \
  && find /opt/pertexo-python -name '*.opt-*.pyc' -delete \
  && strip --strip-unneeded /opt/pertexo-python/bin/python3.15 \
    /opt/pertexo-python/lib/python3.15/lib-dynload/*.so \
  && /opt/pertexo-python/bin/python3.15 -I -c 'import sys; assert sys.version_info[:3] == (3, 15, 1)'

FROM nginxinc/nginx-unprivileged:1.31.7-alpine@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e AS web
ARG SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.source="https://github.com/vigani1/pertexo" \
  org.opencontainers.image.revision=$SOURCE_COMMIT
ENV PERTEXO_API_UPSTREAM=http://api:3000 \
  NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 \
  NGINX_ENVSUBST_FILTER='^(PERTEXO_API_UPSTREAM|NGINX_LOCAL_RESOLVERS)$'
COPY --from=build --chown=101:101 /workspace/apps/web/dist /usr/share/nginx/html
COPY --chown=101:101 apps/web/deployment/nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 8080

FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS production-dependencies
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
COPY . .
RUN pnpm install --prod --frozen-lockfile \
  && find apps packages -type d \( -name src -o -name test -o -name coverage \) -prune -exec rm -rf '{}' + \
  && rm -rf apps/code-runner/native

# Vendor package hashes come from Debian's signed Bookworm security metadata.
FROM scratch AS runtime-security-patches
ADD --checksum=sha256:d2f7edfcc7689b9e0761c2742cc824ac86a20768bc5e8057818dc6875291fe76 https://deb.debian.org/debian-security/pool/updates/main/p/pcre2/libpcre2-8-0_10.42-1+deb12u2_amd64.deb /amd64.deb
ADD --checksum=sha256:8498d2c0bd6747dfc2fc6eec62774a86967079555f7043d5a7b78ee4efbbc0fb https://deb.debian.org/debian-security/pool/updates/main/p/pcre2/libpcre2-8-0_10.42-1+deb12u2_arm64.deb /arm64.deb
ADD --checksum=sha256:d7d1943aec9597629bf73075efcc5ef6dc9bda96d78e80d843156ecd448478b8 https://deb.debian.org/debian-security/pool/updates/main/p/perl/perl-base_5.36.0-7+deb12u4_amd64.deb /perl-amd64.deb
ADD --checksum=sha256:03d979b849a1a0a8955eee28b988dbc25a407fd3a0581df5c94e6ae7bcc01ddf https://deb.debian.org/debian-security/pool/updates/main/p/perl/perl-base_5.36.0-7+deb12u4_arm64.deb /perl-arm64.deb

FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS runtime
ARG SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.source="https://github.com/vigani1/pertexo" \
  org.opencontainers.image.revision=$SOURCE_COMMIT
ENV NODE_ENV=production
WORKDIR /workspace
RUN apt-get update && apt-get install --yes --no-install-recommends \
    libssl3 zlib1g libffi8 libbz2-1.0 liblzma5 tzdata \
  && rm -rf /var/lib/apt/lists/*
COPY --from=python-build --chown=0:0 /opt/pertexo-python /opt/pertexo-python
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
COPY --from=production-dependencies --chown=0:0 /workspace/apps/code-runner/python ./apps/code-runner/python
COPY --from=production-dependencies --chown=10001:10001 /workspace/packages ./packages
COPY --from=build --chown=10001:10001 /workspace/apps/api/dist ./apps/api/dist
COPY --from=build --chown=10001:10001 /workspace/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=10001:10001 /workspace/apps/ops/dist ./apps/ops/dist
COPY --from=build --chown=10001:10001 /workspace/apps/cli/dist ./apps/cli/dist
COPY --from=build --chown=0:0 /workspace/apps/code-runner/dist ./apps/code-runner/dist
COPY --from=build --chown=10001:10001 /workspace/packages/artifact-store/dist ./packages/artifact-store/dist
COPY --from=build --chown=10001:10001 /workspace/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=10001:10001 /workspace/packages/core/dist ./packages/core/dist
COPY --from=build --chown=10001:10001 /workspace/packages/database/dist ./packages/database/dist
COPY --from=build --chown=10001:10001 /workspace/packages/integrations/dist ./packages/integrations/dist
COPY --from=build --chown=10001:10001 /workspace/packages/node-catalog/dist ./packages/node-catalog/dist
COPY --from=build --chown=10001:10001 /workspace/packages/node-sdk/dist ./packages/node-sdk/dist
COPY --from=build --chown=10001:10001 /workspace/packages/nodes-core/dist ./packages/nodes-core/dist
COPY --from=build --chown=10001:10001 /workspace/packages/observability/dist ./packages/observability/dist
COPY --from=build --chown=10001:10001 /workspace/packages/queue/dist ./packages/queue/dist
COPY --from=build --chown=10001:10001 /workspace/packages/rate-limit/dist ./packages/rate-limit/dist
COPY --from=build --chown=10001:10001 /workspace/packages/secrets/dist ./packages/secrets/dist
COPY --from=build --chown=10001:10001 /workspace/packages/templates/dist ./packages/templates/dist
COPY --from=build --chown=10001:10001 /workspace/packages/workflow-engine/dist ./packages/workflow-engine/dist
COPY --from=build --chown=10001:10001 /workspace/packages/workflow-model/dist ./packages/workflow-model/dist
RUN mkdir -p /var/lib/pertexo/artifact-scratch && chown 10001:10001 /var/lib/pertexo/artifact-scratch && chmod 0700 /var/lib/pertexo/artifact-scratch
VOLUME ["/var/lib/pertexo/artifact-scratch"]
USER 10001:10001
CMD ["node", "apps/api/dist/main.js"]
