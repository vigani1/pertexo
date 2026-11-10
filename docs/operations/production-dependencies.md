# Production dependency qualification

Better Auth declares optional peers for its test helpers and schema CLI. Pertexo
uses neither. `.pnpmfile.mjs` removes only its `vitest` and `drizzle-kit` peers
before resolution. The application keeps its own development test/build tools,
and Better Auth keeps its runtime database adapters and browser peers.

Use the supported pnpm [readPackage hook](https://pnpm.io/11.x/pnpmfile) for this
rule. Its checksum and resulting graph are recorded in `pnpm-lock.yaml`. Review
the rule when changing authentication integration or adopting those CLI/helpers.
Do not delete arbitrary files from third-party packages to reduce the image.

J2 measured fresh production-only installs on macOS arm64, from the same aligned
manifests, with lifecycle scripts disabled for the measurement:

| Measurement | Before removing unused peers | After |
| --- | ---: | ---: |
| `du -sk node_modules` | 452,908 KiB | 310,972 KiB |
| Vitest, Vite, jsdom, MSW and Drizzle Kit in the production graph | Present | Absent |

This reduces measured dependency allocation by 141,936 KiB, about 31.3%. The
absolute sizes depend on the platform and filesystem. The local evidence retains
both complete production dependency graphs and install logs.

The Linux runtime image was inspected separately: its dependency directory was
336,064 KiB and contained none of those test tools. The image also carried the
generated 2,047,239-byte third-party notices, including MIT and OFL license text.
The image build still uses a frozen production install and the existing runtime
layout; no additional deployment packaging system was introduced.
