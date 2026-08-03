# Worktree Audit

An interactive terminal assistant for reviewing and reclaiming Git worktrees.

It correlates local Git state with GitHub pull requests and Codex chats when
those tools are available. It fails closed when evidence is missing, stale,
ambiguous, dirty, or active.

## Quick start

Requirements: Node.js 20 or newer, Git, and a terminal. `gh` and `codex` are
optional. Without them, the related evidence stays unknown and no worktree is
eligible for deletion.

```bash
npm install
npm start -- --all --root ~/Projects
```

The default TTY experience is interactive. With `--all`, the CLI recursively
discovers Git repositories below the selected root, deduplicates linked
worktrees that belong to the same repository, and audits every repository
independently. It then opens an `audit>` prompt with slash commands:

```text
/help
/safe
/preview
/delete
DELETE
```

`DELETE` is required after the preview. The CLI re-runs the audit with a deep
process scan and verifies the exact path, branch, commit, clean status, and
open-file state immediately before each removal. Removal uses the non-force
`git worktree remove` command.

Use `--cwd PATH` to audit one repository explicitly. `--root PATH` and
`--repos-dir PATH` are equivalent. Discovery stops at `--max-depth N` (default:
8) and skips dependency/build directories such as `node_modules`, `target`, and
`dist`. Use `--all` or `-all` to audit every repository below `--root PATH`,
`--cwd PATH`, or the current directory when no path is given. Codex chats are
matched independently for every discovered worktree unless `--no-chat` is set.
Use either `--cwd` or `--root`, not both.

## Non-interactive use

```bash
npm run build
node dist/src/cli.js --root ~/Projects --json
node dist/src/cli.js --all --cwd ~/Projects --json
node dist/src/cli.js -all --json
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
| `/select 2,4`  | Select safe rows by number         |
| `/safe`        | Select all safe rows               |
| `/clear`       | Clear the selection                |
| `/preview`     | Review the exact paths and commits |
| `/delete`      | Start the confirmation flow        |
| `/refresh`     | Re-scan the repository             |
| `/json`        | Print the structured audit         |
| `/quit`        | Exit without deleting              |

## Development

```bash
npm run ci
npm run build
npm test
npm run check
```

`npm run ci` is the same locked-install, typecheck, build, and test path used
by GitHub Actions. TypeScript is compiled to `dist/`. Runtime dependencies are
not required after `npm ci`.

## Supply-chain security

Socket Security is configured through the GitHub App and the root
`socket.yml`, following the same model as Invisible. Pull request alerts cover
npm manifests and lockfiles. Install the Socket GitHub App on the repository to
enable the checks; no Socket token is stored in GitHub Actions.
