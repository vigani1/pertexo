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

The owner will acknowledge a report as soon as practical and coordinate
validation, remediation, disclosure, and advisory credit with the reporter.
Acknowledgement is not a promise of a particular resolution date.

## Security checks

Pull requests run dependency review, a production dependency audit, CodeQL, and
the repository's quality and integration gates. Secret scanning is turned on for
the repository. Published images are not scanned for known vulnerabilities yet.
Passing automation does not authorize bypassing a known security or data-integrity
finding.
