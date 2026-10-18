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

## Organization sign-in with OIDC

Owners configure **Settings → Single sign-on**. Admins can read safe settings;
only the current owner of the control workspace can change the identity boundary.
Organization providers are separate from install-wide social sign-in clients.
Google Workspace, Microsoft Entra ID, Okta and other generic OIDC providers use
one authorization-code flow with PKCE and signed ID tokens.

Before configuring a provider, supply a private, random 32-byte base64
`AUTH_FEDERATION_KEY` and `AUTH_FEDERATION_KEY_VERSION` to the API. The fresh-install
secrets generator includes them. Save them separately from database backups.
Never rerun that generator over an existing installation. During rotation, supply
old `{ version, key }` entries in `AUTH_FEDERATION_PREVIOUS_KEYS`. The API refuses
startup when a stored provider secret cannot be opened; restoring the database
also requires the right key ring. These settings belong only in the API's private
configuration, never browser variables or workflow credentials.

1. Create an identity organization in its control workspace.
2. Add each exact domain. Publish the displayed `_pertexo.<domain>` TXT record at
   your DNS provider, then choose **Verify DNS**. Challenges expire after seven
   days; **New challenge** replaces an expired or incorrect one. Verifying a parent
   domain does not claim its subdomains. A domain can belong to only one
   organization on this install.
3. Register a confidential web client at your IdP with the exact redirect URI
   `https://app.example.com/v1/auth/federation/oidc/callback` (use your app origin).
   Add the exact issuer, client ID and secret, then enable sign-in. Issuers and
   their discovery/token/key endpoints must use public HTTPS; private-network
   providers are not supported in this slice.
4. Check the claim names if needed: a scalar email defaults to `email`, and a
   display name to `name`. The signed IdP is authoritative only for its verified
   domains. Explicitly unverified email is refused. Entra's absent
   `email_verified` claim is accepted for organization OIDC; social sign-in still
   requires verified email.
5. **Test sign-in** for each verified domain. Use an identity on that domain.
   Testing preserves your current owner session and creates no account or
   membership. Before **Require SSO**, keep a verified password on the control
   workspace owner's account and successfully test a current enabled provider.

Requiring SSO governs matching accounts across the install, including existing
memberships outside the linked workspaces. It ends existing sessions for that
domain. Passwords, social sign-in, password reset and earlier email-change links
cannot bypass the policy. Affected non-owner accounts cannot change their primary
email through ordinary account settings. The enforcing organization's control
workspace owner retains a protected, audited password login for recovery during
an IdP outage; owning an unrelated workspace grants no exception.

Enable **Allow unprovisioned new accounts** only when JIT provisioning is wanted. A successful
SSO identity receives each linked workspace's configured default role (viewer by
default). Linking a workspace requires ownership of both workspaces. Existing
manual roles remain unchanged; suspended or removed memberships are not restored.
With that option off, existing eligible identities and active directory-provisioned people can still sign in.
Organization methods show the provider name in account security. If organization
SSO is your only method, add another method before changing your primary email:
an address outside the verified domain cannot use that organization's sign-in. Accounts retain
at most 16 sign-in methods; remove an unused method before attaching another.

A provider's issuer is immutable. Changing its configuration ends its sessions
and invalidates its readiness tests. A required domain must keep another current,
tested provider, or you must first make SSO optional. Domain enforcement changes
also end matching sessions, including the owner's if their account uses that
domain. Sign in again with the appropriate method after the change.

Protocol journeys expire after five minutes and succeed once, across API
instances. The API stores no provider access/refresh/ID tokens. Short-lived proof
cleanup and organization/workspace purge use the existing maintenance worker.
The single-server authentication proxy route keeps these callback paths and
endpoint secrets out of nginx access logs.

## Organization sign-in with SAML

Use the same organization, DNS verification, owner/admin read permissions, JIT
roles and recovery account as OIDC above. SAML needs an HTTPS public app address
and secure session cookies, including during local qualification. Ordinary HTTP
development explains this requirement rather than offering an unusable setup.

1. Open **SAML setup and metadata** after creating the organization. Download
   **SP metadata** before creating the IdP application. The organization has one
   stable SP entity ID and ACS URL, for example
   `https://app.example.com/v1/auth/federation/saml/callback`. Changing the public
   app origin requires updating the IdP application. Metadata contains no secrets.
2. Configure an SP-initiated SAML 2.0 application at your IdP. It must accept
   unsigned HTTP-Redirect requests, return HTTP-POST responses, and sign **both
   the response and assertion** using RSA-SHA256 or RSA-SHA512. Use a persistent,
   immutable NameID rather than an email address that someone can change.
   Include scalar `email` and `name` attributes, or configure their exact names.
3. Choose **Add SAML provider**. Copy the exact IdP entity ID, HTTPS SSO URL and
   public PEM signing certificate. Entity IDs may be HTTP/HTTPS identifiers or
   URNs; Pertexo does not fetch them. RSA certificates need at least 2,048-bit
   keys. Sign-in and creation of new accounts start off; enable them deliberately.
4. **Test sign-in** against each verified domain. This works with the provider
   off, preserves the initiating owner session and creates no user or membership.
   Then enable sign-in and test its current revision before requiring SSO.
5. For certificate rotation, add the replacement as the second certificate while
   the first remains valid. Switch signing at the IdP, test, then remove the old
   certificate. Only currently valid certificates verify responses. Metadata
   remains downloadable during certificate expiry so recovery does not depend on
   an already-working IdP configuration. Provider changes end existing sessions
   and invalidate earlier tests; required domains need another tested provider
   or must temporarily make SSO optional before the change.

Pertexo validates signatures, exact issuer/audience/destination/recipient,
request correlation and assertion time bounds. Assertions must be fresh within
five minutes, allowing two minutes of clock skew. The exact callback accepts a
form of at most 512 KiB and signed XML of at most 256 KiB; ask the IdP to send only
the required attributes if its response exceeds these limits. Journeys succeed
once across API instances. Assertions, claims and provider tokens are never
stored in audit entries or run data.

The callback uses a dedicated Secure, HttpOnly, SameSite=None proof cookie;
ordinary session cookies keep their existing SameSite policy. Blocking that
purpose cookie prevents sign-in safely. IdP-initiated SAML, encrypted assertions,
signed SP requests and SAML logout are not supported. Use OIDC when the provider
requires one of those unsupported SAML options.

## Provision users and groups with SCIM

An organization’s control workspace owner manages provisioning under **Settings →
Single sign-on → Directory**. Owners and admins can inspect safe directory
metadata. Provisioning uses the existing API; no identity service subscription is
required by Pertexo.

1. Create a **provisioning credential**, copy the bearer once and save it in your
   password manager. It is shown only in that dialog and must be acknowledged
   before closing. Pertexo stores its digest, not its plaintext. Copy the **SCIM
   base URL**, for example
   `https://app.example.com/v1/auth/federation/scim/<organization-id>/v2`.
2. In an Entra, Okta or other SCIM 2.0 client, configure that base URL and bearer.
   Provision core **Users** and **Groups**, mapping a stable userName, primary
   email, active flag and group membership. Password provisioning, nested groups,
   arbitrary schema extensions and bulk operations are unsupported. The standard
   discovery endpoints describe supported attributes and operations.
3. Map provisioned groups to linked workspace roles. Mappings are ordered: the
   first matching group wins. Otherwise the linked workspace’s default role
   applies. Builder and operator are separate roles, not a privilege ranking.
   Mappings cannot assign owner. Save explicitly; a changed configuration keeps
   your edits and asks you to load current mappings before replacing them.
4. A provisioned person starts as **Awaiting first SSO**. Their verified
   organization OIDC or SAML sign-in binds the directory record to an account and
   applies managed access atomically. This works with **Allow unprovisioned new
   accounts** off. A directory request alone cannot claim an existing account by
   email. Directory profile edits do not rename that account.
5. Existing manual memberships keep their roles and status. After the person has
   completed SSO, use **Review membership** to adopt one deliberately. The review
   shows the exact resulting role and refuses a stale decision. Removed or
   suspended manual memberships are not silently restored. Team rows identify
   directory-managed access and explain why ordinary role, removal, ownership
   transfer and personal-leave controls cannot override it.

Deactivating or deleting a directory user removes managed access and revokes
sessions in the same transaction. Group and role changes revoke affected
sessions too. Inactive and deleted records block JIT from restoring access.
Deleting retains a tombstone; deliberately provisioning an active replacement
requires verified SSO again before previously managed access can return.
Manual memberships and the protected control owner remain outside directory
management.

For credential rotation, create and configure a replacement, verify your IdP can
use it, then revoke the old one. At most five credentials can be active. A lost
creation response cannot reveal the bearer on retry: inspect and revoke the
uncertain credential before creating another. Credentials belong to the
organization, so changing their creator’s role does not revoke them. The current
control workspace owner can revoke them immediately. Revoked credential metadata
is removed after 30 days.

The control workspace owner or the linked workspace’s owner can unlink a
workspace after reviewing the warning. This removes directory-managed access
and mappings there, preserving manual memberships and accounts. The control
workspace itself cannot be unlinked. Organization/workspace deletion removes
its directory resources and source associations through ordinary purge paths.

Bounds are 5,000 retained user records (including deletion tombstones), 200 groups,
500 people per group, ten linked workspaces and 200 role mappings per workspace.
SCIM requests are at most 1 MiB, responses at most 4 MiB, and list pages at most
100 resources. PATCH accepts at most 100 operations. Provisioning is rate-limited;
clients should respect retry feedback. Only modeled core filters and paths are
accepted; unsupported expressions fail clearly rather than being guessed.
All access changes and credential/configuration commands are audited with
metadata only, never bearer credentials, provider assertions or passwords.
