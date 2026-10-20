# Notes on the workflow canvas

Notes explain why a workflow works the way it does. They are documentation;
[comment threads](collaboration.md) remain the place for discussions and mentions.

Choose **Add note** beside the canvas zoom controls, write your text and choose
**Save note**. The new note appears below the existing steps without covering
their controls. Notes save with the draft, using the same permissions and
conflict protection as steps. Viewers can read them; editors can change them.

Use headings, **bold**, *italic*, lists, quotes, code and ordinary links in
Markdown. Very deeply nested formatting is shown as plain text, with the
original text kept for editing. Images, embedded resources and raw HTML are not supported. Links open
in a separate tab; writing a note never loads content from an external site.

Drag a note by its header. Hover or focus it to reveal its resize handles.
Choose **Edit note** (or double-click its text) to change text, colour, position
or size. On a phone, the edit form provides the same position and size controls
without requiring a precision gesture. **Canvas notes**, beside Add note, lists
notes and opens their edit form even when a note is off-screen or covered. Neutral, teal, violet, sage and amber
use the app's Weft palette in light and dark appearance.

With the note focused:

- Arrow keys move it by 10 canvas pixels.
- Shift and arrow keys resize it by 10 pixels.
- Enter opens Edit note; Command/Ctrl+Enter or Command/Ctrl+S saves that form.
- Delete or Backspace removes it; the confirmation toast offers **Undo**.
- Command/Ctrl+D duplicates it. Escape returns focus to the canvas.

The editor's ordinary Undo/Redo also applies. A completed drag or resize is one
change. Notes do not group or move the steps underneath them.

## Publication and portability

Publish includes the notes in the immutable version. A documentation-only edit
can create a new version, and version comparisons list changed notes. It does
not change the compiled workflow, its execution checksum, or the validity of
pinned samples. Run maps remain execution views.

Restore, Duplicate, import/export and promotion preserve notes. They follow the
workflow's visibility and retention, so put only information appropriate for
people who can read that workflow in them. Notes never enter run data or F19
comment threads.

## Limits

A workflow may have 100 notes, each with up to 4,000 characters. Notes start at
320×200 canvas pixels, with a minimum of 200×120 and maximum of 1,200×1,200.
Positions are bounded to ±100,000 canvas pixels. The existing 1 MiB whole-graph
limit still applies, including its steps and notes.
