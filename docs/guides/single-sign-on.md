# Sign-in providers

Google and GitHub sign-in are optional install settings. With no provider
credentials configured, the sign-in page offers email/password only. These
credentials belong to Pertexo's sign-in application, separately from workflow
connections and their credentials.

## Configure Google or GitHub

Set `PUBLIC_WEB_ORIGIN` to the address people use in their browser. Deployed
installs require HTTPS. Register your own application with the provider, using
these exact callbacks (replace the example origin):

| Provider | Callback | Private instance settings |
| --- | --- | --- |
| Google | `https://app.example.com/v1/auth/federation/social/callback/google` | `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET` |
| GitHub | `https://app.example.com/v1/auth/federation/social/callback/github` | `AUTH_GITHUB_CLIENT_ID`, `AUTH_GITHUB_CLIENT_SECRET` |

For Google, create a web application OAuth client and configure its authorized
redirect URI. See [Google's server-side setup](https://developers.google.com/identity/protocols/oauth2/web-server).
For GitHub, register an OAuth App and set its Authorization callback URL; see
[GitHub's setup](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app).
Keep client secrets in private install configuration, never `VITE_*` variables or
Git. Supply both settings for a provider; an incomplete pair refuses startup.

For local development the example origin is `http://127.0.0.1:5173`, with the
same callback paths. Configure that exact origin in the provider application;
changing between `localhost` and `127.0.0.1` changes the callback.

On the single-server deployment, put settings in the private `.env.production`
and follow the normal [deployment procedure](../operations/single-server.md).
Preparation includes provider credentials only in `api.env`; the web, worker,
migration and code-runner services do not receive them. Keep the Caddy
`/v1/auth/*` route and its log redaction: authentication bypasses nginx logs,
including failed callbacks while the API is unavailable.

Existing configured Microsoft/Apple sign-in uses the same verified proof path.
Their callback suffixes are `microsoft` and `apple`. This change closes the old
`/v1/auth/callback/<provider>` path; update provider registrations before enabling
social buttons after an upgrade. Already-started sign-ins may need to be restarted.
Microsoft must return a verified email (configure its optional verified-email claim
when needed). Apple form callbacks are bounded to 32 KiB and redirect to the same
GET callback before the browser-bound proof is accepted; session cookie settings
do not change.

## Account behavior

A provider must prove a verified email address. If a Pertexo account with that
address already exists, its local email must also be verified before automatic
linking. Verify the existing account first when necessary. The provider does not
rename the account or change workspace permissions.

Attaching a new provider signs out previous browser sessions and records an
identity security event. Subsequent sign-ins use the provider's immutable account
identifier; a changed provider email never transfers it to another person's local
account. Provider-only accounts can manage their methods in **Account → Security**.
Explicitly linking a different address there still requires proof of both methods.

A sign-in attempt belongs to one browser, lasts five minutes and succeeds once.
It works across API instances. An invalid/expired callback returns to sign-in with
a generic error, without disclosing whether an account exists. Starting a newer
attempt in the same browser replaces the browser binding; finish that newer one.

Better Auth continues to issue and verify the signed session cookie. Social
proof tokens are not saved as workflow connections or OAuth access/refresh tokens.
Linking, security audit, previous-session revocation and the new session commit
in one short transaction after provider verification. Expired proof rows are
eligible for the existing retention sweep a day after expiry.

Organization OIDC/SAML, domain enforcement and directory provisioning are the
remaining [F28 slices](../feature-plans/28-single-sign-on-and-provisioning.md).
They are not enabled by social client credentials.
