# Process a list with For each

Add **For each**, map its `items` input from a list, and open its body. Map a
body step's input from **Current item** or the zero-based **Item ordinal**.
Expressions in the body read them as `loop.item` and `loop.ordinal`, for
example `loop.item.price * loop.item.quantity`. Links inside the body determine
its execution order. Nested bodies use their nearest enclosing item; the
workflow's run input stays the original run input.

**Maximum items** declares the largest collection this loop accepts, up to
**4,998**. **Items at a time** bounds concurrent iterations. Start with `1`,
particularly for Call workflow: children share the parent's active-run slot and
run serially. Raising this setting does not grant more workspace or worker
capacity. A loop waits until its body finishes for every item, then continues.

Steps after the loop see the original `items`, `iterationCount` and `results`:
what the body's last step returned for each item, in item order. A pass that
skipped that step, for example on a Condition's other branch, gives `null`.
Map `$.results` to use them, for instance in a Table rows step or a summary.
All results together must fit within the 1 MiB value limit; if they don't, the
next step fails and asks you to return less from the loop's last step.

## Bounds and publication

A run allows 5,000 total loop iterations and 5,000 expanded step invocations.
Nested iterations multiply; a Call also counts its child's expanded steps.
Triggers and controls count too. For example, Manual start → For each with one
Set body step can process 4,998 items; adding Stop run leaves room for 4,997.
Longer bodies and called workflows permit fewer items.

The full collection is reserved before that loop admits any items. Budget is not
refunded after an iteration finishes. Publishing checks declared worst cases,
including both branches, rather than guessing how much data will arrive.

The retained concurrent expansion stays at 200 invocations. Nested **Items at a
time** settings multiply this frontier, while ordinary steps outside the loops
also occupy it. If publication asks you to reduce Items at a time, lower outer
and/or inner concurrency. The checkpoint still has its 256 KiB cap. JSON byte,
member and depth limits also apply: wide records may fit fewer than 4,998 items.

## Batch larger lists

When a list is too large for the work in each iteration, put **Batch items**
before For each. Set its batch size, map its `batches` output (`$.batches`) to
For each's `items`, and have the body process a whole batch as one operation.

For example, split 4,998 invoice IDs into batches of 100. For each then runs 50
iterations, with the last holding 98 IDs. Inside the body, map **Current item**
to an HTTP API's bulk-ID input. Use a batch size and concurrency that the service
allows; those HTTP calls have the usual effects and retry rules.

Batching does not reset the run's budgets. Adding a second For each inside the
body to visit every ID still counts every inner iteration and step. Lists over
the 4,998-item collection cap, or over the value-size envelope, must be split by
the source into separate bounded runs; batching cannot accept an oversized value.
See [data transforms](data-transforms.md#batching-work-for-for-each) for mappings.

## Work with file pages

For a larger CSV/JSON source, choose **Read file → Output pages** (or HTTP pagination's **Save items as pages**), then map `$.pages` into an outer For each. Inside it, **Read file** the Current item in **Inline data** mode. Use the resulting bounded array in list operations, or an inner For each.

For example, a 2,000-row file can produce two 1,000-row pages: set the outer maximum to 2 and the inner maximum to 1,000, with a small body that fits publication's existing whole-run bounds. Start both at one item at a time. A page has at most 1,000 records; wide records make smaller pages. Prefer Filter/Summarize or a bulk operation per page when individual steps would exhaust the run budget.

Paging keeps bytes outside the checkpoint; it does **not** reset the 5,000 iteration/expanded-step budgets, increase capacity or accept an oversized mapped array. Keep loop results small and split larger workloads into separate runs. [Create file → From pages](files.md#work-with-larger-data-as-explicit-pages) can combine ordered pages without an inner row loop.
