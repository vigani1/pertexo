# F32 — HTTP Request pagination

Status: approved by the owner 2026-10-19; ready for implementation.
Parent: [product roadmap](../product-roadmap.md). Size: **M**.

## Outcome

Many APIs return results one page at a time. With pagination turned on, an
HTTP Request step follows the pages for you and outputs every item as one
list, so a later For each, Filter or table step sees all of them. This
matches [n8n's HTTP Request pagination](https://docs.n8n.io/build/code-in-n8n/cookbook/http-request-node/pagination)
(next-page URL or a page counter). Provider integrations (F21) will reuse it.

## Today

- The step lives in `packages/integrations/src/http-request/`:
  - `validation.ts` holds the config, input and output schemas
  - `executor.ts` makes one request
  - `definition.ts` holds the manifest
- One request returns one response. The body comes back inline up to
  `inlineResponseBytes` (256 KB at most), with `json` when it parses, or as a
  stored file up to 10 MiB.
- GET and HEAD are treated as repeatable (`executor.ts`, `repeatable`): their
  failures retry and can follow a failure link.
- The origin (scheme, host, port) is fixed by the URL setting. `{name}`
  placeholders only fill the path, query and headers, so "a connection's
  secret headers never follow run data to another host"
  ([step capability upgrades](step-capability-upgrades.md)). Address checks,
  including the private-network allowlist, run at dispatch.
- `returnErrorResponses` (optional, added in #394) shows how an optional
  setting is added without a new definition version.
- Step input and output are bounded at 1 MiB by the node SDK.
- The setup form is generated from the config schema's `.meta()` titles and
  descriptions. Custom inspector sections live in
  `apps/web/src/features/workflow-editor/components/inspector/`.
- The user guide is `docs/guides/http-requests.md`.

## Decisions

1. **A new optional `pagination` setting**, off when absent. Existing configs
   and the definition version are unchanged, following the
   `returnErrorResponses` precedent.
2. **GET only.** Validation refuses pagination with any other method. GET is
   repeatable, so a retry starts again from the first page, which the guide
   states. Paging a POST search API can come later, if users ask.
3. **Four modes**, one per common API style:

   | Mode | Settings | Next request |
   | --- | --- | --- |
   | Next page link | where the link is: a JSON path in the body (`$.next`), or the `Link` header's `rel="next"` | the link, resolved against the current page's URL |
   | Cursor | JSON path to the next cursor (`$.meta.next_cursor`) and the query parameter to send it in (`cursor`) | the first URL with that parameter set |
   | Page number | query parameter (`page`) and the first number (default 1) | the parameter plus 1 each page |
   | Offset | query parameter (`offset`), its first value (default 0) and the step (the page size) | the parameter plus the step each page |

   Every mode also takes:
   - **Items path** (required): a JSON path to the list on each page, for
     example `$.data`, or `$` when the page itself is a list
   - **Max pages**: 1 to 100, default 10
   - **Delay between pages**: 0 to 10,000 ms, default 0
4. **JSON paths reuse the existing syntax and reader.** These are the
   `$.status` / `$.items[0].id` paths the list steps use (`collectionPathSchema`,
   format `json-path`, from #392). If that schema lives in `nodes-core`, move
   it to `node-sdk` first in a move-only commit, so `integrations` can use it
   without a reverse dependency.
5. **Stopping.** Stop when any of these happens:
   - the next link or cursor is missing, `null` or empty
   - the next link or cursor is the same as the previous one, which guards
     against a loop
   - a page's item list is empty
   - Max pages is reached
6. **Same origin, always.** A next-page link must have the same scheme, host
   and port as the first request. If it doesn't, the step fails with
   `http.pagination_origin_changed`, and the connection's credentials are
   never sent elsewhere. Every page goes through the same dispatch address
   checks and redirect limit as a single request.
7. **Pages must be JSON** within `inlineResponseBytes`. A page that isn't JSON
   or is larger fails with a clear message naming the page number. Paged
   responses are never stored as files.
8. **Errors.** A page with a non-2xx status fails the step, the same way a
   single request fails today, including 429 with `Retry-After`.
   `returnErrorResponses` together with pagination is refused in this first
   slice.
9. **Output.** With pagination on, the step outputs:

   ```json
   {
     "items": [],
     "pageCount": 3,
     "complete": true,
     "status": 200,
     "headers": {},
     "finalOrigin": "https://api.example.com"
   }
   ```

   - `items` is every page's list, joined in order.
   - `complete` is `false` only when Max pages stopped it while another page
     existed.
   - `status`, `headers` and `finalOrigin` come from the last page.

   The output schema becomes a union of today's shape (unchanged) and this
   one, so mapping suggestions offer `items`.
10. **Size.** The joined output must fit the 1 MiB step-output limit. If it
    would go over, the step fails with `http.pagination_too_large`, and the
    message suggests lowering Max pages or narrowing the request. F45 (bigger
    data) lifts this later. It never silently returns partial data except
    through `complete: false`.
11. **Time.** `timeoutMillis` applies to each page. Validation refuses a
    setup whose worst case (`maxPages × (timeoutMillis + delay)`) can't fit
    the step's attempt time budget; check the worker's attempt deadline. The
    step checks for cancellation between pages and during the delay.
12. **Editor.** Add a Pagination section in Setup, collapsed and set to Off by
    default:
    - a Mode choice (Off, Next page link, Cursor, Page number, Offset)
    - only that mode's fields, plus Items path, Max pages and Delay
    - a one-line sentence under the choice saying what it will do, for
      example "Follows `$.next` until it's empty, up to 10 pages."

    Prefer the generated schema form. Write a small custom section only if
    the generated form can't show one mode's fields at a time cleanly.
13. **Telemetry.** Record pages fetched as a bounded number, with no URLs or
    cursors in labels or logs.

## Slices

1. **Engine.** All of this sits in `packages/integrations/src/http-request/`:
   - the config schema and validation messages
   - the executor loop
   - the output union and error codes

   Unit tests against a local test server:
   - each mode end to end
   - every stop rule
   - the same-origin refusal
   - non-JSON and oversized pages
   - the 1 MiB limit
   - Max pages with `complete: false`
   - a delay with fake timers
   - cancellation mid-way
   - a 429 on page 2
   - credentials sent on every page and never to another host
2. **Editor and docs.**
   - the Pagination section, mapping suggestions for `items`, and validation
     messages in plain words
   - a mocked browser test
   - a live journey or worker integration test: a three-page mock API
     through a real run and a single-step test
   - a "Fetch every page" section in `docs/guides/http-requests.md`

## Acceptance

- [ ] A real run against a three-page JSON API outputs all items in order,
      with `pageCount: 3` and `complete: true`.
- [ ] Each of the four modes works, and each stop rule ends paging correctly.
- [ ] A next link to another host fails without sending credentials there.
- [ ] Max pages gives `complete: false`, and the size limit gives a clear
      failure.
- [ ] A step without pagination behaves exactly as before; all existing HTTP
      tests pass unchanged.
- [ ] Setup shows only the chosen mode's fields, works on a phone, and
      explains what it will do.
- [ ] The guide section is published and the roadmap row is updated.

## Non-goals

- Paging methods other than GET
- Paging inside a request body
- Responses stored as files while paging
- Running pages in parallel
- Expressions in pagination settings; JSON paths cover the common APIs,
  and expressions can come later if needed

## Delivery tracker

| Slice | Status | PR |
| --- | --- | --- |
| 1 Engine | Approved | — |
| 2 Editor and docs | Approved | — |
