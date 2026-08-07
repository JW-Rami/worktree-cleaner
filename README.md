# Worktree Audit

An interactive terminal assistant for reviewing and reclaiming Git worktrees.

It correlates local Git state with GitHub pull requests and Codex chats when
those tools are available. Missing, stale, or ambiguous identity evidence stays
blocked. Local risk signals are warnings, so a confirmed candidate remains
selectable when it is dirty, has open processes, contains unclassified ignored
files, or has an active Codex chat.

## Quick start

Requirements: Node.js 20 or newer, Git, and a terminal. `gh` and `codex` are
optional. Without them, the related evidence stays unknown and no worktree is
eligible for deletion.

```bash
npm install
npm start
```

By default, the CLI uses the parent directory of the current Git repository as
the workspace root. It recursively discovers sibling and nested repositories,
deduplicates linked worktrees that belong to the same repository, and audits
every repository independently. Repository audits run in parallel with a
bounded concurrency of 4. Worktree evidence searches also run in parallel,
with a bounded concurrency of 8. Use `--cwd PATH` to restrict the audit to one
repository, `--root PATH` to choose the workspace root explicitly,
or `--concurrency N` to tune per-worktree searches from 1 to 32. The longer
`--worktree-concurrency N` spelling remains accepted as an alias.

`--all` and `-all` remain available to make the recursive workspace scan
explicit. If the selected path is a Git repository, its parent directory is
used as the workspace root. If it is not a repository, the selected directory
is used:

```bash
npm start -- --all --root ~/Projects
```

The default TTY experience is an interactive dashboard. It separates primary
worktrees from linked worktrees, shortens long paths to the terminal width, and
uses a left cursor instead of requiring row numbers. The list is a viewport
inside the terminal: moving the cursor automatically scrolls it and shows the
current position as `row N/M`:

```text
↑/↓ move · space select · enter command · /help · q quit
```

`◆ MAIN` rows are the primary worktrees and are protected from deletion. `○ SAFE`
rows are deletion candidates. `⚠️` marks a SAFE row with local warnings, while
`✅` marks a selected SAFE row. `🔒` marks a row blocked by missing or ambiguous
identity evidence. Selected rows are colored and bold in a color-capable TTY.
Press `Space` to toggle the focused row. Press `Enter` to type a slash command:

```text
/help
/safe
/preview
/delete
DELETE
```

`DELETE` is required after the preview. The CLI re-runs the audit with a deep
process scan and verifies the exact path, branch, and commit immediately before
each removal. Clean SAFE rows use `git worktree remove`. SAFE rows with warnings
use `git worktree remove --force` only after the exact `DELETE` confirmation.
This can remove uncommitted or ignored data, so the warning is intentional.

The local warnings mean:

- `DIRTY`: Git reports uncommitted changes or the status check was unavailable.
- `OPEN PROCESSES`: a process has this worktree, or the process scan was unavailable.
- `IGNORED`: ignored files are present but are not recognized as rebuildable
  directories such as `node_modules`, `dist`, `build`, or `.next`, or the scan
  was unavailable.
- `ACTIVE CODEX CHAT`: an exact Codex chat matched the worktree and reports the
  `active` status. It is a warning, not proof that the chat is currently writing.

`/preview` shows these warnings before confirmation. `/delete` never removes a
row blocked by missing, stale, or ambiguous GitHub or Codex identity evidence.

Set `NO_COLOR=1` to disable ANSI color while keeping the selection markers.

`--root PATH` and `--repos-dir PATH` are equivalent and always take precedence.
Discovery stops at
`--max-depth N` (default: 8) and skips dependency/build directories such as
`node_modules`, `target`, and `dist`. Codex chats are matched independently for
every discovered worktree unless `--no-chat` is set. Use either `--cwd` or
`--root`, not both. Lower `--concurrency` if local Git or process scans put too
much load on the machine.

## Non-interactive use

```bash
npm run build
node dist/src/cli.js --root ~/Projects --json
node dist/src/cli.js --all --cwd ~/Projects --json
node dist/src/cli.js -all --json
node dist/src/cli.js --all --concurrency 16
node dist/src/cli.js --cwd /path/to/repository
node dist/src/cli.js --cwd /path/to/repository --merged-only
node dist/src/cli.js --no-github --no-chat
```

The JSON mode is suitable for scripts. Multi-repository JSON includes
`root`, `repositories`, flattened `rows`, and `errors`, so callers can report
partial discovery without treating it as a complete scan. A non-TTY without
`--json` prints a human-readable report and performs no mutation.

## Commands

| Command        | Purpose                            |
| -------------- | ---------------------------------- |
| `/help`        | Show the command reference         |
| `/list`        | Show the current dashboard         |
| `/filter safe` | Show only deletion candidates      |
| `/select 2,4`  | Select visible rows by number       |
| `/safe`        | Select all safe rows               |
| `/clear`       | Clear the selection                |
| `/preview`     | Review the exact paths and commits |
| `/delete`      | Start the confirmation flow        |
| `/refresh`     | Re-scan the repository             |
| `/json`        | Print the structured audit         |
| `/quit`        | Exit without deleting              |

Arrow-key selection is equivalent to `/select`: focus a row with `↑` or `↓`,
press `Space` to toggle it, then use `/preview` and `/delete`. SAFE rows with
warnings enter the deletion preview; blocked rows do not. Row numbers follow
the current visible order and can change when a filter changes.

## Development

```bash
npm run ci
npm run build
npm test
npm run test:e2e
npm run check
```

`npm run ci` is the same locked-install, typecheck, build, unit-test, and CLI
interaction E2E path used by GitHub Actions. The E2E test launches the compiled
CLI in a POSIX pseudo-terminal and sends real arrow and Space keys. It uses
Python 3's standard `pty` module to provide that terminal in local and CI runs.
TypeScript is compiled to `dist/`. Runtime dependencies are not required after
`npm ci`.

## Supply-chain security

Socket Security is configured through the GitHub App and the root
`socket.yml`, following the same model as Invisible. Pull request alerts cover
npm manifests and lockfiles. Install the Socket GitHub App on the repository to
enable the checks; no Socket token is stored in GitHub Actions.
