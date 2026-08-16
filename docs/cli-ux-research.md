# CLI UX research

Date: 2026-08-16

The current Worktree Cleaner problem is not a missing command. It is a lack of
visible state: the list, details, input, progress, and errors compete for the
same terminal space.

## Patterns worth adopting

- [Google Cloud interactive shell](https://docs.cloud.google.com/sdk/docs/interactive-gcloud)
  separates previous output, command input, active help, and status display.
  It also makes navigation and selection shortcuts explicit.
- [Azure CLI interactive mode](https://learn.microsoft.com/en-us/cli/azure/interactive-azure-cli)
  keeps command descriptions, examples, and key gestures visible and
  configurable.
- [Firebase CLI initialization](https://firebase.google.com/docs/cli#initialize-a-firebase-project)
  uses a guided sequence of choices and leaves a concrete configuration behind
  so the next command has an understandable scope.
- [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode)
  distinguishes input from navigation, exposes a shortcut panel, supports
  redraw, command history, transcript/detail views, and explicit dialogs.
- [OpenAI Codex CLI](https://github.com/openai/codex/tree/main/codex-rs)
  separates the full-screen TUI from the headless execution CLI. Its TUI
  configuration documents dedicated list and pager navigation instead of
  treating the terminal as an unstructured log.
- [Grok Build](https://github.com/xai-org/grok-build)
  describes a full-screen TUI with scrollback, prompt, and modal components.

## Decisions for Worktree Cleaner

1. Keep rows intentionally compact. Show complete paths, branches, evidence,
   timestamps, and local checks in a focused details panel.
2. Make the current mode explicit: navigation, command, confirmation, or
   operation in progress.
3. Keep a visible operation event log. Every refresh, validation, removal,
   failure, and final result must remain on screen until the next action.
4. Show list position and viewport position, for example `focus 17/131` and
   `rows 14-22 of 131`.
5. Treat local conditions such as dirty files, open processes, or unknown
   ignored files as warnings. Keep missing identity evidence visibly separate
   as the reason a row is not `SAFE`.
6. After deletion, re-audit the same scope before reporting the dashboard as
   current. A successful Git command alone is not sufficient UI feedback.
7. Preserve a non-interactive path for scripts. Interactive affordances must
   not change JSON output or make automation depend on prompt wording.
