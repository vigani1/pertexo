# Third-party licenses

The existing CI security job checks every installed third-party package, including
build tools, using `pnpm licenses:check`. A missing, unknown or restricted license
fails the check. Application dependencies must use permissive licenses: MIT,
Apache-2.0, BSD-2/3-Clause, ISC, 0BSD, Unlicense, CC0, BlueOak, Python-2.0 or Zlib.
The existing `(MIT OR CC0-1.0)` expression is accepted. New license families
and expressions require review.

The explicit exceptions in `infrastructure/checks/third-party-notices.mjs` are:

- Fontsource variable fonts: OFL-1.1 permits redistribution with the font license
  and reserved names retained. The published license ships in the notices.
- `caniuse-lite`: CC-BY-4.0 browser compatibility data is a build input; notices
  preserve its attribution.
- `lightningcss` and its platform binaries: MPL-2.0, unmodified build tooling.
  These compiler sources are absent from the production web bundle and runtime
  install. Retain their license in the build's notices as well.

The image build generates `THIRD_PARTY_NOTICES.txt` from the installed manifests
and published license, copyright, COPYING and NOTICE files. It ships at
`/workspace/THIRD_PARTY_NOTICES.txt` in the runtime image and at
`/usr/share/nginx/html/THIRD_PARTY_NOTICES.txt` in the web image. The file is a
superset covering the build and runtime npm graphs. Base images retain their own
upstream operating-system notices.

Review exceptions when upgrading the affected package. Do not add an exception
merely to turn CI green: record the package, license, distribution use and reason.

## Completeness and copied software

The generator reads each installed package's own LICENSE, COPYING, NOTICE and
copyright files. If they do not contain a grant, it extracts README license
sections, including Markdown underline headings. A link or SPDX identifier alone
is not license text. Every installed version must supply text or match an explicit
version-scoped exception in `infrastructure/checks/license-supplements.json`.
That file also retains upstream text for known npm publishing omissions, with its
source and the reviewed package versions. Platform binaries use the corresponding
wrapper package's published license; a new version requires review.

The missing-text exceptions cover test/build inputs absent from both production
distributions: `is-node-process` 1.2.0 and `strict-event-emitter` 0.5.1 (MSW),
`stackback` 0.0.2 (Vitest), `ipv6-normalize` 1.0.1 (SMTP test server), and `keyv`
4.5.4 (ESLint cache). Their publishers omit the grant text. Retain any available
copyright/disclaimer or original source grant and its attribution. These exceptions
do not permit unknown versions or a new runtime library. Drizzle Kit's metadata
declares MIT while its upstream monorepo provides Apache-2.0; the notices state
that discrepancy and retain the full upstream text for this build-only CLI.

`infrastructure/checks/copied-software-licenses.json` inventories CPython 3.15.1
and its bundled standard-library acknowledgements, including expanded expat COPYING
text, from the checksum-verified archive. Its URL and checksum must match Dockerfile.
Debian PCRE2/Perl security patches retain their base-system copyright files under
`/usr/share/doc`. The native launcher and copied application/configuration are
Pertexo code. Python's documentation conservatively includes components disabled
in this installation. Verify the generated text against the installed Python LICENSE
when rebuilding. Update the inventory when changing the Python pin.

Pertexo does not copy or ship rclone or its Go dependencies. Backup operations run
the digest-pinned official upstream image as short-lived containers. Its pin lives
in `infrastructure/single-server/backup/compose.yaml`, covered by the existing
Compose Dependabot group. There is no rclone license exception or source-distribution
mechanism in Pertexo, and its notices do not inventory that external service.

The backup image catalog belongs to the operator scripts, independently of the
selected installed release. This also permits backup-before-upgrade when that
older release predates the external transport. Its directory is covered by the
existing grouped Compose Dependabot entry.
