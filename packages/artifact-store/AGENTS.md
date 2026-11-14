# @pertexo/artifact-store

Follow the [root rules](../../AGENTS.md); this file only adds to them.

## Purpose and boundary

Workspace artifact bytes in an S3-compatible bucket: put, verified read,
signed direct upload and download, readiness and workspace purge. Every read
is checked against the length and SHA-256 its metadata declares. Node only
(`@pertexo/artifact-store/server`); the API, the worker and the single-server
backup and storage scripts use it.

It never decides who may read an artifact (callers check authority first),
never stores artifact rows (PostgreSQL does, through `core`) and never logs
(it reports through its object-store observer).

## Layout

- `src/server.ts`: the entry.
- `src/config.ts`: the `ARTIFACT_STORE_*` environment, read once.
- `src/artifact.store.ts`: `createArtifactStore`, the facade callers use.
- `src/artifact-identity.ts`: an artifact's identity and storage key.
- `src/artifact-store.errors.ts`: integrity, not-found and closed errors.
- `storage/`: the S3 implementation, one file per operation (read, signed
  upload and download, purge), the request schemas and their bounds
  (`artifact-request.schemas.ts`), stored metadata (`metadata.ts`), stream
  verification, the S3-backed store runtime (`s3-artifact-storage.runtime.ts`)
  and the observed wrapper.
- `s3/`: the S3 client seam, request deadlines, response handling (not-found,
  draining and closing bodies) and object-store telemetry.

## Where new code goes

- A new store operation: a method on `ArtifactStore`
  (`storage/artifact-storage.types.ts`), its operation file in `storage/`,
  wired in `storage/s3-artifact-storage.runtime.ts` and observed in `storage/observed.ts`.
- A new S3 command: add it to `ObjectStoreS3Command` in `s3/s3-client.ts` and
  name its operation in `s3/telemetry.ts`.
- A new setting: `config.ts`, with its default and bounds named there.

## Defaults and config

- Environment: `config.ts` (`ARTIFACT_STORE_*`, `ARTIFACT_MAX_BYTES`), with
  the default and ceiling object sizes, bucket-name and request-timeout bounds.
- Signed URL lifetime, purge page size and media-type length:
  `storage/artifact-request.schemas.ts`.

## Rules

- Every byte read is verified before a caller sees it; a mismatch is an
  `ArtifactIntegrityError`, also reported as a safety violation.
- Every S3 call goes through `sendS3` with a request signal, so it has a
  deadline and is observed.

## Exceptions

- The root files beside the entry are listed with their reasons in
  `ROOT_CONCEPTS` (`infrastructure/checks/validate-package-roots.mjs`).
- `config.ts` takes `process.env` as its default argument; the backup scripts
  call it without one.

## What guards it

- `pnpm --filter @pertexo/artifact-store test`: config, verification,
  deadlines and the store against a mocked S3 client.
- `pnpm --filter @pertexo/artifact-store test:integration` needs an S3 mock
  (`ARTIFACT_STORE_INTEGRATION=true` and the `ARTIFACT_STORE_*` variables).
- `pnpm check`: package structure, naming, environment and backend-limits
  checks.
