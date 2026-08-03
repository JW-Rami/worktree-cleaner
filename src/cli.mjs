#!/usr/bin/env node

import { createInterface } from "node:readline";

import {
  auditWorktrees,
  DECISIONS,
  parseArgs,
  removeWorktree,
  renderAudit,
  verifyRemovalTarget,
} from "./audit.mjs";

const DELETE_CONFIRMATION = "DELETE";
const PROMPT = "audit> ";
const DEFAULT_FILTER = "all";
const SAFE_FILTER = "safe";
const FILTERS = new Set([DEFAULT_FILTER, SAFE_FILTER, "review", "unknown"]);
const VERSION = "0.1.0";
const MAX_PREVIEW_ROWS = 20;

const HELP = `
Commandes:
  /help                  Afficher cette aide
  /list                  Afficher les worktrees visibles
  /filter <nom>          Filtrer: all, safe, review, unknown
  /select <n,...>        Sélectionner des lignes sûres
  /safe                  Sélectionner toutes les lignes SAFE
  /clear                 Vider la sélection
  /preview               Prévisualiser la suppression
  /delete                Demander confirmation, puis revalider avant suppression
  /refresh               Refaire l'audit complet
  /json                  Afficher le résultat structuré
  /plain                 Afficher le rapport non interactif
  /cancel                Annuler la confirmation en cours
  /quit                  Quitter

Les lignes SAFE sont les seules sélectionnables. La suppression exige ensuite
la saisie exacte de DELETE et une seconde vérification Git/processus.
`;

function progressWriter(errorOutput) {
  return (progress) => {
    if (progress.stage === "worktrees") {
      errorOutput.write(
        `🔎 ${progress.total} worktrees détectés. Analyse en cours...\n`,
      );
    } else if (progress.stage === "processes") {
      errorOutput.write("⚙️ Scan des processus...\n");
    } else if (progress.stage === "sizes") {
      errorOutput.write(
        `📦 Mesure des tailles: ${progress.completed}/${progress.total}\n`,
      );
    } else if (progress.stage === "github") {
      errorOutput.write("🔗 Vérification des PR GitHub...\n");
    } else if (progress.stage === "chats") {
      errorOutput.write("💬 Association des chats Codex...\n");
    }
  };
}

function rowMatchesFilter(row, filter) {
  if (filter === DEFAULT_FILTER) return true;
  if (filter === SAFE_FILTER)
    return row.decision === DECISIONS.REMOVE_CANDIDATE;
  if (filter === "review") return row.decision === DECISIONS.REVIEW;
  return row.decision === DECISIONS.UNKNOWN;
}

function visibleRows(audit, filter) {
  return audit.rows.filter((row) => rowMatchesFilter(row, filter));
}

function rowIndexMap(rows) {
  return new Map(rows.map((row, index) => [index + 1, row]));
}

function safeRows(rows) {
  return rows.filter((row) => row.decision === DECISIONS.REMOVE_CANDIDATE);
}

function formatRow(row, index, selected) {
  const selectedMarker = selected.has(row.path) ? "*" : " ";
  const pullRequest = row.pr.pullRequest
    ? `PR #${row.pr.pullRequest.number} ${row.pr.pullRequest.state}`
    : row.pr.kind;
  const chat = row.chat.threads[0]
    ? `${row.chat.threads[0].title} [${row.chat.threads[0].status}]`
    : `chat ${row.chat.kind}`;
  return `${selectedMarker} ${String(index).padStart(2)} ${row.marker} ${row.size.padStart(9)} ${row.path} · ${pullRequest} · 💬 ${chat} · dirty=${row.dirtyCount ?? "?"} open=${row.openProcessCount ?? "?"}`;
}

export function renderInteractive(
  audit,
  { selected = new Set(), filter = DEFAULT_FILTER } = {},
) {
  const rows = visibleRows(audit, filter);
  const safeCount = safeRows(audit.rows).length;
  const selectedCount = audit.rows.filter((row) =>
    selected.has(row.path),
  ).length;
  const lines = [
    `\n🧹 Worktree Audit · ${audit.repository ?? "dépôt Git local"}`,
    `${audit.rows.length} worktrees · ${safeCount} SAFE · ${selectedCount} sélectionné(s) · filtre=${filter}`,
    "Commandes: /help /safe /preview /delete /refresh /quit. Les lignes SAFE sont supprimables après double validation.",
    "",
  ];
  if (rows.length === 0) {
    lines.push("Aucune ligne pour ce filtre.");
  } else {
    rows.forEach((row) =>
      lines.push(formatRow(row, audit.rows.indexOf(row) + 1, selected)),
    );
  }
  lines.push(
    "",
    "* sélectionné · SAFE sélectionnable · REVIEW/UNKNOWN conservé par défaut",
  );
  return lines.join("\n");
}

function parseIndexToken(token, maxIndex) {
  const range = token.match(/^(\d+)-(\d+)$/u);
  if (range) {
    const start = Number.parseInt(range[1], 10);
    const end = Number.parseInt(range[2], 10);
    if (start < 1 || end < start || end > maxIndex) return [];
    return Array.from(
      { length: end - start + 1 },
      (_, offset) => start + offset,
    );
  }
  const index = Number.parseInt(token, 10);
  return String(index) === token && index >= 1 && index <= maxIndex
    ? [index]
    : [];
}

export function parseSelection(value, maxIndex) {
  const tokens = String(value ?? "")
    .split(/[\s,]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
  const indexes = new Set();
  const invalid = [];
  for (const token of tokens) {
    const parsed = parseIndexToken(token, maxIndex);
    if (parsed.length === 0) invalid.push(token);
    for (const index of parsed) indexes.add(index);
  }
  return { indexes: [...indexes].sort((left, right) => left - right), invalid };
}

export function parseInteractiveCommand(line) {
  const value = String(line ?? "").trim();
  if (!value) return { command: "noop", argument: "" };
  const normalized = value.startsWith("/") ? value.slice(1) : value;
  const [command = "", ...rest] = normalized.split(/\s+/u);
  return { command: command.toLowerCase(), argument: rest.join(" ") };
}

function selectedRows(audit, selected) {
  return audit.rows.filter((row) => selected.has(row.path));
}

function printPreview(output, rows) {
  output.write(`\nPreview de suppression (${rows.length}):\n`);
  rows.slice(0, MAX_PREVIEW_ROWS).forEach((row) => {
    output.write(`- ${row.path} (${row.size}) · ${row.head}\n`);
  });
  if (rows.length > MAX_PREVIEW_ROWS) {
    output.write(`- ... ${rows.length - MAX_PREVIEW_ROWS} autre(s)\n`);
  }
}

async function collectAudit(args, errorOutput, auditFn) {
  return auditFn({
    cwd: args.cwd,
    noGithub: args.noGithub,
    noChat: args.noChat,
    deepProcessScan: args.deepProcessScan,
    onProgress: progressWriter(errorOutput),
  });
}

export async function executeDeletion({
  audit,
  paths,
  args,
  output,
  errorOutput,
  auditFn,
  removeFn,
  verifyFn,
}) {
  const latestAudit = await collectAudit(
    { ...args, deepProcessScan: true },
    errorOutput,
    auditFn,
  );
  const latestRows = new Map(latestAudit.rows.map((row) => [row.path, row]));
  let removed = 0;
  for (const path of paths) {
    const row = latestRows.get(path);
    if (
      !row ||
      row.decision !== DECISIONS.REMOVE_CANDIDATE ||
      !verifyFn({ repoRoot: audit.repoRoot, row })
    ) {
      output.write(`Conservé, preuve insuffisante: ${path}\n`);
      continue;
    }
    const result = removeFn({ repoRoot: audit.repoRoot, path: row.path });
    if (result.status === 0) {
      output.write(`Supprimé: ${row.path}\n`);
      removed += 1;
    } else {
      output.write(`Échec de suppression: ${row.path}\n`);
    }
  }
  return { audit: latestAudit, removed };
}

export async function runInteractiveSession({
  audit,
  args,
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  auditFn = auditWorktrees,
  removeFn = removeWorktree,
  verifyFn = verifyRemovalTarget,
} = {}) {
  let currentAudit = audit;
  let filter = DEFAULT_FILTER;
  let selected = new Set();
  let pendingDeletion = null;
  let closed = false;

  const show = () => {
    output.write(`${renderInteractive(currentAudit, { selected, filter })}\n`);
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    output.write("\nSession terminée.\n");
  };
  const readline = createInterface({
    input,
    output,
    terminal: Boolean(input.isTTY && output.isTTY),
    prompt: PROMPT,
  });

  show();
  readline.prompt();

  return new Promise((resolve) => {
    readline.on("close", () => {
      finish();
      resolve(0);
    });
    readline.on("line", async (line) => {
      readline.pause();
      try {
        const value = String(line ?? "").trim();
        if (pendingDeletion) {
          if (value === DELETE_CONFIRMATION) {
            const result = await executeDeletion({
              audit: currentAudit,
              paths: pendingDeletion,
              args,
              output,
              errorOutput,
              auditFn,
              removeFn,
              verifyFn,
            });
            currentAudit = result.audit;
            selected = new Set();
            output.write(`\n${result.removed} worktree(s) supprimé(s).\n`);
          } else if (["/cancel", "cancel"].includes(value.toLowerCase())) {
            output.write("Suppression annulée.\n");
          } else if (
            ["/q", "/quit", "/exit", "q", "quit", "exit"].includes(
              value.toLowerCase(),
            )
          ) {
            pendingDeletion = null;
            readline.close();
            return;
          } else {
            output.write("Suppression annulée: confirmation exacte requise.\n");
          }
          pendingDeletion = null;
          show();
          return;
        }

        const parsed = parseInteractiveCommand(value);
        if (parsed.command === "noop") return;
        if (["q", "quit", "exit"].includes(parsed.command)) {
          readline.close();
          return;
        }
        if (parsed.command === "help" || parsed.command === "?") {
          output.write(`${HELP}\n`);
        } else if (parsed.command === "list" || parsed.command === "show") {
          show();
        } else if (parsed.command === "filter") {
          const nextFilter = parsed.argument || DEFAULT_FILTER;
          if (!FILTERS.has(nextFilter)) {
            output.write(
              `Filtre inconnu: ${nextFilter}. Valeurs: ${[...FILTERS].join(", ")}\n`,
            );
          } else {
            filter = nextFilter;
          }
        } else if (parsed.command === "safe") {
          selected = new Set(
            safeRows(currentAudit.rows).map((row) => row.path),
          );
          filter = SAFE_FILTER;
        } else if (
          ["clear", "unselect"].includes(parsed.command) &&
          !parsed.argument
        ) {
          selected = new Set();
        } else if (["select", "unselect"].includes(parsed.command)) {
          const rows = visibleRows(currentAudit, filter);
          const selection = parseSelection(
            parsed.argument,
            currentAudit.rows.length,
          );
          if (selection.invalid.length > 0) {
            output.write(`Lignes invalides: ${selection.invalid.join(", ")}\n`);
          }
          for (const index of selection.indexes) {
            const row = rowIndexMap(currentAudit.rows).get(index);
            if (!row || !rows.includes(row)) {
              output.write(`Ligne non visible: ${index}\n`);
            } else if (row.decision !== DECISIONS.REMOVE_CANDIDATE) {
              output.write(`Ligne ${index} non SAFE, conservée.\n`);
            } else if (parsed.command === "select") {
              selected.add(row.path);
            } else {
              selected.delete(row.path);
            }
          }
        } else if (parsed.command === "preview") {
          const chosen = selectedRows(currentAudit, selected);
          if (chosen.length === 0)
            output.write("Aucune suppression sélectionnée.\n");
          else printPreview(output, chosen);
        } else if (parsed.command === "delete") {
          const chosen = selectedRows(currentAudit, selected);
          if (chosen.length === 0) {
            output.write(
              "Aucune suppression sélectionnée. Utilise /safe ou /select.\n",
            );
          } else {
            printPreview(output, chosen);
            output.write(
              `Tape ${DELETE_CONFIRMATION} pour confirmer, ou /cancel.\n`,
            );
            pendingDeletion = new Set(chosen.map((row) => row.path));
          }
        } else if (parsed.command === "cancel") {
          output.write("Aucune suppression en attente.\n");
        } else if (parsed.command === "refresh") {
          currentAudit = await collectAudit(args, errorOutput, auditFn);
          selected = new Set();
          output.write("Audit actualisé.\n");
        } else if (parsed.command === "json") {
          output.write(`${JSON.stringify(currentAudit, null, 2)}\n`);
        } else if (parsed.command === "plain") {
          output.write(`${renderAudit(currentAudit, { color: false })}\n`);
        } else {
          output.write(`Commande inconnue: ${parsed.command}. Tape /help.\n`);
        }
        if (!closed && !["list", "show"].includes(parsed.command)) show();
      } catch (error) {
        output.write(
          `Erreur: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      } finally {
        if (!closed) {
          readline.resume();
          readline.prompt();
        }
      }
    });
  });
}

export async function runCli({
  argv = process.argv.slice(2),
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    output.write("Usage: worktree-audit [options]\n");
    output.write(
      "Options: --interactive --json --cwd PATH --merged-only --no-github --no-chat --deep-process-scan --version\n",
    );
    output.write(
      "Sans option dans un TTY, le mode interactif démarre automatiquement.\n",
    );
    return 0;
  }
  if (args.version) {
    output.write(`${VERSION}\n`);
    return 0;
  }
  if (args.interactive && (!input.isTTY || !output.isTTY)) {
    throw new Error("--interactive nécessite un terminal interactif (TTY).");
  }
  const audit = await collectAudit(args, errorOutput, auditWorktrees);
  const filteredAudit = args.mergedOnly
    ? {
        ...audit,
        rows: audit.rows.filter((row) => row.pr.kind === "MERGED_EXACT"),
      }
    : audit;
  if (args.json) {
    output.write(`${JSON.stringify(filteredAudit, null, 2)}\n`);
    return 0;
  }
  const interactive = args.interactive || Boolean(input.isTTY && output.isTTY);
  if (!interactive) {
    output.write(`${renderAudit(filteredAudit, { color: false })}\n`);
    output.write(
      "Mode non interactif. Utilise un TTY ou --interactive pour les commandes.\n",
    );
    return 0;
  }
  return runInteractiveSession({
    audit: filteredAudit,
    args,
    input,
    output,
    errorOutput,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(
        `worktree-audit: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    });
}
