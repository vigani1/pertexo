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
