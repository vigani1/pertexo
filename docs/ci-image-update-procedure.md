# CI service image update procedure

The local integration and observability Compose contracts use immutable image
manifest digests. The tag before `@sha256:…` is retained as an operator-readable
version label, while the digest is what CI and local Compose actually pull.

To update an image:

1. Choose the reviewed upstream version and resolve its multi-platform manifest
   digest with `docker buildx imagetools inspect REPOSITORY:TAG`.
2. Update the matching default in `compose.yaml`,
   `infrastructure/observability/compose.yaml`, `.env.example`, and the CI
   environment in `.github/workflows/ci.yml` when that image is used in CI.
3. Record the old tag/digest and new tag/digest in the pull request. Keep the
   tag and digest on the same reference; do not replace it with a mutable tag.
4. Run `pnpm images:check`, `docker compose config`, and the complete migration,
   integration, and recovery matrix. For observability changes, also start the
   observability Compose stack and retain its health/log output.
5. Merge only after the image scan and all required CI jobs pass. A digest update
   is a supply-chain change and requires normal code review.

Local users may override any image with `POSTGRES_IMAGE`, `REDIS_IMAGE`,
`S3MOCK_IMAGE`, or `MINIO_IMAGE` in `.env`; CI does not read those local
overrides and supplies explicit immutable values.
