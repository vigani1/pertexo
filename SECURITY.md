# Security Policy

## Supported versions

Pertexo is an unreleased personal engineering project. Security fixes target the
current `main` branch; no older release line is supported.

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub's **Report a
vulnerability** security-advisory form for this repository. Do not open a public
issue, discussion, or pull request containing exploit details, secrets, customer
data, credentials, or production identifiers.

Include the affected component and revision, impact, reproduction conditions,
and a minimal proof of concept when it is safe to share. Use synthetic data and
redact tokens, connection strings, logs, and request payloads.

The owner will acknowledge a report as soon as practical, triage it on the same
business day, and coordinate validation, remediation, disclosure, and advisory
credit with the reporter. Acknowledgement is not a promise of a particular
resolution date. High or critical issues block release until fixed or covered by
a documented, owner-accepted, time-bounded exception.

## Security checks

Pull requests and release candidates run dependency review, production
dependency audit, CodeQL, secret scanning, image scanning, and the repository's
quality and integration gates. Passing automation does not authorize bypassing a
known security or data-integrity finding.
