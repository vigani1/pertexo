# Dependency review log

The default CODEOWNER reviews ignored majors and overrides monthly. Review the
installed versions and registry releases afresh, record a decision and a review
date within 30 days, and open a dedicated migration PR when changing a major.
This log complements the weekly process in `dependency-updates.md`; it adds no CI
job. Security advisories follow that process's shorter service levels.

## Review opened 2026-11-10

Registry versions were queried with `pnpm view <package> version`; the raw results
are in batch J2's local audit evidence. Owner: @vigani1. These migrations remain
pending review; the table does not claim compatibility has been tested.

| Package | Installed | Latest | Reason for retaining current version | Review by |
| --- | --- | --- | --- | --- |
| `@nestjs/core` | 11.2.8 | 12.4.2 | Review framework, Fastify adapter and testing migration together. | 2026-12-10 |
| `uuid` | 13.0.2 | 14.0.3 | Review runtime and exported API compatibility before changing shared identifiers. | 2026-12-10 |
| `@xmldom/xmldom` | 0.8.15 | 0.9.12 | Existing SAML parser type/error-handling deferral in dependency-updates.md. | 2026-11-19 |

OpenTelemetry moved to the coordinated 3.0.0/0.300.0 family on 2026-11-12;
see [the completed migration](dependency-updates.md#opentelemetry-3-migration-2026-11-12).

## Overrides reviewed 2026-11-10

Retain these pins until the parent packages resolve the patched version on their
own. At the next review, remove a pin only after regenerating the lockfile and
checking every dependency path, the production audit and relevant tests.

| Override | Reason | Removal condition | Review by |
| --- | --- | --- | --- |
| `@opentelemetry/api: 1.10.0` | Align SDK 3 and optional peers so Drizzle's error class has one identity. | One API resolution and rollback/admission tests pass without the override. | 2026-12-12 |
| `@esbuild-kit/core-utils>esbuild: 0.25.12` | Drizzle's legacy configuration loader resolves vulnerable esbuild 0.18. | Parent loader upgrades beyond that vulnerable line. | 2026-12-10 |
| `fastify: 5.12.8` | Align Nest's transitive adapter and the app's direct Fastify version at the patched release. | All parent paths resolve the same supported patched release. | 2026-12-10 |
| `fast-uri@^3.0.0: 3.1.9`, `fast-uri@^4.0.0: 4.2.3` | Patched vulnerable transitive versions, retaining each parent's major (06aff8ab2). | All parent paths select patched versions. | 2026-12-10 |
| `js-yaml@^4.0.0: 4.3.2` | Fix empty-merge-source CPU exhaustion in ESLint/knip's loader (473e2e1bf). | Parent paths select 4.3.2 or a later patched version. | 2026-12-10 |
| `source-map-js: 1.2.2` | Fix GHSA-68fv-2mgg-jv7q across transitive paths (c13f2c50d). | Every parent resolves a fixed release without the override. | 2026-12-10 |
