# Call an API with HTTP Request

**HTTP Request** sends one request and hands the response to the steps after it.

## Address and run data

Set the method and an `https` address. To use run data in the address, put a
`{name}` placeholder in the path or query, for example
`https://api.example.com/orders/{orderId}?page={page}`. Header values can hold
placeholders too, such as `X-Customer: {customerId}`. Each name becomes an
input: open **Inputs**, add it (the name is suggested) and map a value. The
editor flags any placeholder left unmapped.

Values are percent-encoded in the address, so `a/b` stays one path segment and
`x&y` stays one query value. Header values may not contain line breaks. The
scheme, host and port never take run data, so a connection's secret headers
can't follow run data to another server.

## Authentication

Leave **HTTP headers connection** empty for an API that needs no key. To send a
key, choose a connection. Its headers are added to the request, and their
values are redacted from logs and from the response body. A connection that was
removed has to be replaced before the workflow can publish.

## The response

A successful response (2xx) gives `status`, `headers`, `finalOrigin` and `body`.
To handle error answers yourself, turn on **Return error responses**: a 3xx, 4xx
or 5xx response then comes back the same way instead of failing the step, so a
**Condition** can check `status`, for example `status = 404`. Up to the inline
size (64 KB by default, at most 256 KB), the body comes back as text in
`body.value`. When the response is JSON (`application/json`, any `+json` type or
`text/json`), the parsed value is also in `body.json`, so a later step can map
`$.body.json.order.id`. Larger responses are kept as a file, which **Read file**
or another HTTP request can use. See [files](files.md).

## Failures and retries

Unless the step returns error responses, a 4xx answer fails the step. A **GET**
or **HEAD** that times out, loses its connection or gets a 5xx is tried up to
three times, because reading has no side effect. If it still fails, it can
follow the step's **On failure** link. Other methods are never repeated
automatically. If one may have reached the server, the run stops with an unknown
outcome rather than risk doing the work twice.

## Private networks

On a self-hosted install, requests reach only public addresses until an
administrator lists the networks to allow in `HTTP_ALLOWED_PRIVATE_NETWORKS`.
Inside those networks plain `http` also works. See
[single-server operations](../operations/single-server.md).
