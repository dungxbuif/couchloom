# Safe MCP Tool Surface

## Decision

The CouchLoom MVP exposes note reads, note creation/overwrite, and bounded note
editing. It does not expose destructive or path-changing operations to agents.

Allowed write tools:

- `write_note` — create a note or replace its complete content;
- `edit_note` — append, prepend, or replace one exact text occurrence.

Disallowed tools:

- `delete_note`;
- `move_note`.

Human deletions observed through CouchDB `_changes` may still remove derived
search/vector records. This is index reconciliation, not an agent capability.

## Configuration Impact

`READ_ONLY=true` disables `write_note` and `edit_note`. `WRITE_FOLDERS` limits
those two tools to configured vault-relative folders. There is no environment
switch that restores delete or move tools in the MVP.

## Verification

The tool-catalog unit test must prove that read/create/edit tools are present,
that read-only mode removes both write tools, and that delete/move are absent in
all modes. The server instructions and public README must list the same surface.
