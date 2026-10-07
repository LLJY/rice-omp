# opencode-import

Converts [OpenCode](https://opencode.ai) (1.18.x, SQLite store) sessions, subagent sessions included, into native [omp](https://github.com/can1357/oh-my-pi) sessions that `omp --resume` continues with full context (tool calls and their results, compactions, reverts, usage).

It lives outside `agent/`, so `install.sh` does not copy it. Requires `bun` and an installed `omp` (its package is found from the `omp` binary; set `OMP_PACKAGE_DIR` to the `@oh-my-pi/pi-coding-agent` package root to override). Sessions are written through omp's own `SessionManager`, so the files are what omp itself would write.

## Usage

```sh
bun src/cli.ts --since 90d --dry-run                 # plan only: roots, descendants, message counts, status
bun src/cli.ts --since 90d                           # convert into omp's normal per-cwd session dirs
bun src/cli.ts ses_abc ses_def --session-dir /tmp/x  # explicit ids, flat into one dir
```

| Option | Meaning |
|---|---|
| `ses_...` | Explicit OpenCode session ids. |
| `--ids-file FILE` | JSON array of ids, or of objects with an `id` field (e.g. a scorer's `scores.json`). |
| `--all` | Every root session. |
| `--since 90d\|12h\|4w\|DATE` | Roots with `time_updated` at or after that point. `90d` counts calendar days back from local midnight; a date is local midnight; an ISO timestamp is exact. |
| `--project DIR` | Roots whose directory is `DIR` or inside it, by a bounded relative-path check (`/work/a` does not match `/work/ab`; a Windows-style `C:\work\app` or `C:\` is compared with Windows rules on any host). |
| `--db FILE` | OpenCode database. Default `${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db`. |
| `--session-dir DIR` | Write flat into `DIR` (the layout `omp --session-dir DIR` reads). Default: omp's per-cwd directory under its sessions root, as a plain `persistCopy` does. |
| `--dry-run` | Print the plan; write nothing. |
| `--force` | Re-convert even when unchanged, or when the earlier output was modified after import. |
| `--default-model P/M` | omp model that sessions with no resolvable source model resume on (see "Models"). Must be one `omp models` lists. Default: omp's configured `modelRoles.default`. |
| `--fallback-cwd DIR` | Optional. Re-root sessions whose source directory no longer exists. |

`--all`, `--since` and `--project` combine with AND; explicit ids are always added. Selection is by root session: every selected root brings all its descendants (recursively through `parent_id`), whatever their own `time_updated`. A child id selected directly converts its own subtree as a standalone session (no parent link); if its ancestor is selected too it is already inside that bundle.

Progress goes to stderr. The plan or the final summary (converted / skipped / failed counts, time, sessions/s, MB/s) goes to stdout. Exit status: 0 ok, 1 some sessions failed, 2 usage or fatal error, 130 interrupted.

## Subagents: native layout

omp keeps a subagent next to its parent (`src/task/executor.ts`, `src/session/sub-sessions.ts`):

```
<dir>/<ts>_<uuid>.jsonl                               parent
<dir>/<ts>_<uuid>/<AgentId>.jsonl                     child; header.parentSession = parent file path
<dir>/<ts>_<uuid>/<AgentId>.md                        child's final output
<dir>/<ts>_<uuid>/<AgentId>/<AgentId>.<Name>.jsonl    grandchild (ids are dot-qualified by the owner's id)
```

The importer writes exactly that. `AgentId` is the task description as PascalCase (`Validate fallback plan` -> `ValidateFallbackPlan`), `[A-Za-z0-9_-]` only, at most 48 characters, de-duplicated like omp's `AgentOutputManager` (`Name`, `Name-2`). Each OpenCode `task` call whose `state.metadata.sessionId` is a converted child is rewritten so omp's own navigation works:

- the tool result text is omp's `<task-result id="AgentId" ...>` envelope (full output inline) and `details.results[0]` is a `SingleResult` with `id: AgentId` (what TUI task cards and HTML export use to open the sub-session);
- the tool call arguments are shown in omp's task schema (`tasks: [{agent, name, task}]`); the OpenCode arguments stay in `details.opencode.originalArguments`;
- `details.usage` carries the child's spend in the form omp's statistics read (`SessionManager.getUsageStatistics`, `SessionStatsTracker`). A child that several `task` calls resume is split over those calls (by call duration, exact integers) so its cumulative totals are counted once;
- `history://AgentId` and `agent://AgentId` resolve from the resumed parent (verified: both read the child, `history://` as `(parked)`), and omp's `collectSubSessions` (`/export`, `/dump all`) finds the tree.

`<AgentId>.md` is the child's last assistant text on its *active* branch: text a child's own revert undid is not returned by `agent://`.

A resumed task call (`task_id`) maps to the same child. A task call whose child is not in the imported subtree (OpenCode forks copy the original session's task calls) stays an ordinary tool result with `details.opencode.unlinkedChildSessionId`. Not reproduced: `details.results[0].outputPath` (the parent's file name is only known after omp creates it; omp resolves `agent://` by scanning, not by that field) and a live agent registry entry (omp restores parked children from disk on resume).

## What maps

- Messages: user text/images; assistant text, thinking, tool calls per step (`step-start`/`step-finish` -> one omp assistant turn each, with that step's usage; OpenCode `reasoning` tokens are folded into omp `output`, with `reasoningTokens` kept).
- Tools: every call gets exactly one result. `completed` -> output (pruned results become `[Old tool result content cleared]`, original kept in `details`); `error` -> `isError` (an interrupted tool keeps its partial output); `pending`/`running` -> `[Tool execution was interrupted]`, as OpenCode itself replays them. Failed or aborted assistant messages are marked `error`/`aborted`, which omp drops from context like OpenCode does.
- Compaction: a finished OpenCode compaction becomes an omp `compaction` entry. With a retained tail, `firstKeptEntryId` is the first context-producing entry of the tail; without one it is the compaction entry itself. A failed attempt is archived, not a boundary.
- Revert: whole or partial reverts leave the reverted messages (and the cut part of a partial one) off the active branch as a sibling chain; an `opencode_revert` marker is the leaf.
- Provenance: `opencode_message` (one per source message, with parts omp has no equivalent for), `opencode_import` (source id, timestamps, cost, tokens, permissions, counts, subagent ids) custom entries; file mtime = source `time_updated`.
- Cwd: the source directory is kept even when it no longer exists. Plain `--resume <id>` then asks interactively to re-root it into the current directory (verified: it prompts and rewrites the header; non-TTY it refuses with a clear error and changes nothing); `--resume <path>` opens it directly and keeps the launch cwd. `--fallback-cwd` is only for forcing a different root at import time.

### Models

omp restores a resumed session's model from its newest explicit default `model_change`, and otherwise from the `provider/model` of the assistant messages. The importer emits a `model_change` for each source model `omp models --json` can resolve. When *no* source model on a session's active branch resolves (say `openai/gpt-6-sol` through a proxy-only omp), a bare `omp --resume` would stop with `Could not restore model ...`; so such a session gets one explicit `model_change` as its first entry, to a validated target: `--default-model`, else omp's own `modelRoles.default` (`omp config get modelRoles`, minus the thinking suffix) if omp can resolve it. An `opencode_model_mapping` entry records the unresolved source models and the target, and `--model` on resume still overrides it. With no resolvable target at all the session is listed in the summary (`model:` line): resume it with `--model`.

## What is lost

Provider-native reasoning signatures and encrypted content (archived, never replayed); per-bucket cost split (only the aggregate survives); non-image binary attachments (replaced by a note, bytes stay in OpenCode); filesystem undo/snapshots (`revert` is recorded, files are not restored); OpenCode `session_message` v2 control rows (copied into `opencode_import.data.v2ControlRows` only); a running or pending tool cannot be resumed; the original transport (`api` is `opencode-import`); a subagent's own per-step usage is not split per task call (only its cumulative total is, see above).

## Idempotency, replacement and recovery

`<session dir or sessions root>/.opencode-import.json` records, per imported root (a *bundle*: the root and every descendant), each file written with its size, mtime and SHA-256, plus a *source revision* per session.

- **Change detection.** A revision is a hash of the whole `session` row (title, revert, directory, cost, tokens, `time_updated`, ...) and, for its messages, parts and control rows, the row count, newest `time_updated` and a sum of all `time_updated`s, taken in the same read transaction as the converted rows. Title edits and message/part updates that do not advance `session.time_updated` are caught. Not visible: a row rewritten in place without its own `time_updated` or count changing (OpenCode's projectors do bump it). A re-run skips a bundle whose revisions, member set and converter version all match; any difference (also a descendant that failed last time, or missing output) re-converts the whole bundle.
- **Divergence.** Before a bundle is replaced, every file it owns is hashed against the manifest, and its artifacts directory is scanned for files the importer did not write. If any member was modified (a child continued in omp, an edited title: omp rewrites the title slot at the same size) or an extra file appeared (a new omp subagent), the bundle is reported `diverged` and nothing is touched; `--force` replaces it anyway.
- **Atomic replacement.** A new bundle is staged completely under `<dir>/.opencode-import-staging/<id>/`. Only if every previously converted session converted again is it published: an *intent* is saved to the manifest, the old root and artifacts directory are moved to `<dir>/.opencode-import-trash/<id>/`, the staged artifacts then the staged root are renamed into place, and one atomic manifest save commits the new bundle and drops the intent. If a session that used to convert now fails, the previous bundle is kept untouched and the failure is reported; unrelated roots continue.
- **Crash recovery.** A killed run leaves either nothing in the session dir or an intent in the manifest. The next run (under the lock, before planning) rolls an intent forward when every file of the new bundle is in place with its recorded hash, otherwise deletes the partial new files and restores the previous bundle from the trash; orphan staging/trash directories and manifest temp files are swept.
- **Lock.** One importer at a time per destination: `<dir>/.opencode-import.lock` (O_EXCL; pid, host, token). A second importer waits (up to two minutes), then fails naming the holder. A lock whose pid is gone on the same host is taken over; staleness is pid liveness only, so a recycled pid on the same host keeps a dead importer's lock until you delete the file.

## Safety

- The OpenCode database is opened with `bun:sqlite` `{ readonly: true }` (SQLITE_OPEN_READONLY), never `immutable`, so a live OpenCode writer (WAL) is read consistently and nothing can be written. The `sqlite3` CLI is not needed: `bun:sqlite` opens the 39 GB live database read-only fine.
- `message`/`part` are only read per session through their `session_id` indexes inside one short read transaction; only the (small) `session` table is scanned. Memory per session is the session's own JSON.
- Output goes only where you point it: `--session-dir`, or omp's sessions root. Nothing in OpenCode's data directory is touched. Importing omp's `SessionManager` makes omp open its own state files (`agent.db`, `history.db`, `models.db`) in the agent dir, as any omp start does. Staging lives beside the manifest, so publication is a same-filesystem rename.
- A bad session never aborts the batch: it is logged, summarized at the end, and (if a child) recorded in the manifest so the next run retries its bundle. Ctrl-C finishes the current root and stops.
- Imported transcripts contain your original prompts, tool output and file contents verbatim; treat them as sensitive as the OpenCode database.

## Tests

```sh
cd tools/opencode-import && bun test
```

Builds a synthetic OpenCode database from `tests/schema.sql` (no real data) and checks, through omp's own loader and consumers: tool pairing (completed, error, never-finished, interrupted), compaction with and without a tail, whole and partial revert, native child layout and parent links (incl. nested), `--since`/`--ids-file`/`--project` selection pulling descendants, dry-run, cwd handling, manifest idempotency, failure isolation; and the replacement guarantees: a diverged child or same-size title edit blocks replacement, a failed child keeps the old bundle, title/part changes without `session.time_updated` are detected, interruption at every publication step is reconciled, concurrent importers (in one process and as separate processes) serialize, restorable models are resolvable (`getRestorableSessionModels`), task usage is counted once in `SessionManager.getUsageStatistics` / `SessionStatsTracker`, and `agent://` of a reverted child returns the surviving output. Needs an installed `omp`; skipped otherwise.
