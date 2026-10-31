# Call an API with HTTP Request

**HTTP Request** calls an API and hands its response to the steps after it.
Turn on pagination to combine a sequence of JSON pages into one list.

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
removed has to be replaced before the workflow can publish. A service that signs
in with OAuth2 works the same way, with a token that renews itself: see
[OAuth2 connections](oauth2-connections.md).

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


## Fetch every page

Open **Setup → Pagination** and choose a mode. Pagination supports **GET**;
turn **Return error responses** off. **Items path** names the list on each
page, such as `$.data`, or `$` when the response itself is a list.

| Mode | Set | Stops when |
| --- | --- | --- |
| Next page link | A JSON path such as `$.next`, or the `Link` header’s `rel="next"` | The next link is missing, null, empty or already visited |
| Cursor | Next cursor path and the query parameter, such as `$.meta.next_cursor` and `cursor` | The next cursor is missing, null, empty or already visited |
| Page number | Query parameter and first page (default 1) | A page’s item list is empty |
| Offset | Query parameter, first offset (default 0) and offset step matching the service’s page size | A page’s item list is empty |

**Max pages** is 10 by default, from 1 to 100. **Delay between pages** is 0 by
default, up to 10 seconds. Requests run one after another. A relative next link
uses the current page’s address, including a same-origin redirect. Every page
and redirect must keep the first request’s scheme, host and port; otherwise
the step fails before sending credentials to that destination. Private-network
rules apply to every page.

For example, suppose `https://api.example.com/orders` returns:

```json
{ "data": [{ "id": 1 }], "next": "?page=2" }
```

Choose **Next page link → JSON response**, set **Next link path** to `$.next`
and **Items path** to `$.data`. When three pages return one order each and the
last returns `"next": null`, the result is:

```json
{
  "items": [{ "id": 1 }, { "id": 2 }, { "id": 3 }],
  "pageCount": 3,
  "complete": true,
  "status": 200,
  "headers": { "content-type": "application/json" },
  "finalOrigin": "https://api.example.com"
}
```

Map `$.items` into the next list or For each step. Paginated output uses
`items` instead of `body`; status, safe headers and origin describe the last
page. `pageCount` includes an empty page fetched to find the end.

`complete: false` means Max pages stopped paging with a continuation value
still present (or a nonempty page in counter modes). A missing, null or empty
next link/cursor means `complete: true`, even on the last allowed page. Pertexo
checks only that value's presence at the cap; it never follows the unused link
or makes another request to prove the end. Check this flag when the next step
needs every item.
Repeated links or cursors end paging without making another request.

Each page must be JSON and fit **Largest page** (64 KB by default, at most
256 KB). Larger pages fail; they are never stored as files. The combined output
must fit the step’s 1 MB, depth and member limits. An oversized result fails
with the page number and advice to lower Max pages or narrow the request; it
does not return a partial list.

Timeout applies separately to each page. The worst case — Max pages multiplied
by timeout plus delay — must fit the remaining run or single-step test budget.
If a test refuses this setup, lower Max pages, timeout or delay. A 429 uses a
bounded Retry-After hint (integer seconds, at most one minute) with the existing
step retry policy. Choose the total tries and fixed wait with
[step retry settings](step-retries.md). A retry fetches from the first page again. Cancellation also
stops an inter-page delay.

### Save items as pages

Under **Setup → Pagination → Results**, choose **Save items as pages** when the combined list cannot fit inline. Each provider response still must fit **Largest page** (at most 256 KB), and Max pages still allows at most 100 requests. The existing navigation, origin, redaction, retry and deadline rules are unchanged.

The result has `pages`, `itemCount`, `pageCount`, `fetchedPageCount`, `complete`, `status`, `headers` and `finalOrigin`. `pageCount` counts stored JSON-array files; `fetchedPageCount` counts provider requests, including an empty final response. `items` is absent in this explicit mode. Files can be packed across provider response boundaries, in record order.

The shared page limits are 64 KB / 1,000 records per file, 10 MB / 100,000 records / 256 files overall. A single record must fit one page, and all files must finalize before success. A later provider or storage failure never returns a successful partial bundle. Retries fetch from the first request again; abandoned partial files expire normally. Map `pages` to an outer For each, then Read file each page inline, or map the ordered pages to Create file's From pages mode. See [file pages](files.md#work-with-larger-data-as-explicit-pages).
