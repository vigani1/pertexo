# OAuth2 connections

An OAuth2 connection lets HTTP Request steps call a service with a token that renews
itself. You give it the service's addresses and client, sign in once, and steps use it
like any other connection. If the sign-in stops working, the connection says so, and
reconnecting fixes it without touching the workflows that use it.

## Add one

Owners and admins can do this. Open **Connections → HTTP** and choose **OAuth2**.

1. Copy the **Redirect URL** and register it with the service.
2. Choose how it signs in. **Sign in with consent** opens the service's sign-in page in a
   new window. **Server to server** needs no person: Pertexo gets a token with the client
   alone.
3. Fill in the **Authorization URL**, **Token URL**, **Client ID**, **Client secret** and
   **Scope**. The scope is sent exactly as you type it, because services disagree on
   separators.
4. Name it, then **Connect**. The step names the hosts you're about to trust, so check
   them. Finish signing in in the window that opens; your page stays as it was, so an
   unsaved workflow behind it is safe.

**Advanced** holds the client authentication (Basic header, or Request body if the service
refuses Basic), PKCE, extra parameters such as Google's `access_type=offline` or Auth0's
`audience`, and **Allowed API hosts**. Parameters aren't secret storage: anyone who can see
the connection can read them.

## Who can do what

| Role | Can |
|---|---|
| Viewer | See the connection, its settings and status, never its secret |
| Operator, Builder | Also pick it in steps and test it, within connection sharing |
| Owner, Admin | Also create, connect, reconnect, change settings, share and revoke |

## In a step

The HTTP Request connection picker lists active OAuth2 connections beside header ones. A
step can't set its own `Authorization` header: saving refuses that name, so a published
step always sends the connection's token. The token goes only to hosts the connection
allows; `*.example.com` covers subdomains, not `example.com` itself.

## Renewal, and what a 401 does

A token is renewed when it is used and has less than a minute left. An outage at the
token address doesn't fail a step while its token still works.

When the API answers **401** to a GET or HEAD, Pertexo renews the token and asks once more.
A POST, PUT, PATCH or DELETE is **never sent twice**, because nothing proves a 401 means
nothing happened: the step fails, and the next run uses a new token.

A 401 or 403 from an API never changes the connection. Otherwise any step pointed at any
URL could break it for everyone. Only the token address can do that, which has a
consequence: **a grant someone revokes at the service shows here at the next renewal**,
when its token is due, not at the next call. Until then the API's 401s fail those steps.

## When it needs reconnecting

| It says | Why | What to do |
|---|---|---|
| Not connected yet | Nobody has signed in | **Connect** |
| Sign-in revoked | The service no longer accepts it | **Reconnect** |
| Client refused | The client ID or secret was refused | **Edit settings**, then connect |
| Token expired | The service gave no way to renew it | **Reconnect** |

**Edit settings** asks for the client secret again and always asks for new consent. That
stops someone with manage rights pointing a stored secret at their own address. Steps
already running with the old settings fail before they send anything.

**Revoke** deletes Pertexo's tokens. It doesn't call the service, so revoke access there
too.

## Private addresses

Addresses must be public https unless the operator lists their network in
`HTTP_ALLOWED_PRIVATE_NETWORKS`. Pertexo's own host is always refused, and every request
re-checks where the name resolves. Token requests never follow a redirect.

## Restoring a backup

Tokens are backed up, sealed. A restored backup may hold a refresh token the service has
since rotated: the next renewal shows **Sign-in revoked**, and reconnecting fixes it.
