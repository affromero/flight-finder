#!/usr/bin/env node
// commander 13 ships an ESM entry (esm.mjs) that re-exports `program` as a
// named binding from the CJS index. There is no default export, so use the
// named import. Node 22 in production resolves commander v13 from the
// workspace local node_modules (see Dockerfile), not the root v2 hoist.
import { program } from 'commander';
import { render } from 'ink';
import React from 'react';
import { App } from './app.js';
import { launchTmuxView } from './lib/tmux-view.js';

program
  .name('flightfinder')
  .description('The price trail airlines don\'t show you')
  .option('--headless', 'Terminal UI mode (required for CLI interaction)')
  .option('--list', 'Show all tracked queries (web) or with --headless (terminal)')
  .option('--view <id>', 'View price chart (web) or with --headless (terminal)')
  .option('--tmux', 'Split grouped routes into tmux panes (requires --headless --view)')
  .option('--json', 'Output JSON: with --view <id> one tracker, otherwise the full list')
  .option('--backend <provider>', 'AI backend: claude-code, codex, anthropic, openai, google')
  .option('--model <model>', 'Model override (e.g. sonnet, opus, gpt-4.1-mini, codex)')
  .option('--reset-password <username>', "Reset a user's password (multi user mode); pair with --new-password")
  .option('--new-password <password>', 'New password to set (use with --reset-password)')
  .option('--disable-accounts', 'Disable multi user mode and clear stored credentials (self hosted)')
  .parse();

const opts = program.opts() as { headless?: boolean; list?: boolean; view?: string; tmux?: boolean; json?: boolean; backend?: string; model?: string; resetPassword?: string; newPassword?: string; disableAccounts?: boolean };

const baseUrl = process.env.FLIGHT_FINDER_URL
  ?? `http://localhost:${process.env.HOST_PORT ?? process.env.PORT ?? '3003'}`;

// Set backend/model override — update DB config so parse-query.ts and extract-prices.ts pick it up.
// Skipped during recovery so those commands never write config as a side effect.
if (opts.backend && !opts.resetPassword && !opts.disableAccounts) {
  process.env.FLIGHT_FINDER_BACKEND = opts.backend;

  const defaultModels: Record<string, string> = {
    'claude-code': 'sonnet',
    codex: 'codex',
    anthropic: 'claude-haiku-4-5-20251001',
    openai: 'gpt-4.1-mini',
    google: 'gemini-2.0-flash',
  };

  const model = opts.model ?? defaultModels[opts.backend] ?? opts.backend;

  import('@/lib/prisma').then(({ prisma }) => {
    prisma.extractionConfig.upsert({
      where: { id: 'singleton' },
      update: { provider: opts.backend!, model },
      create: { id: 'singleton', provider: opts.backend!, model, enabled: true, scrapeInterval: 3 },
    }).catch(() => { /* DB may not be available yet */ });
  });
}

// --tmux requires --headless
if (opts.tmux && !opts.headless) {
  console.error('Error: --tmux requires --headless mode');
  console.error('Usage: flightfinder --headless --view <id> --tmux');
  process.exit(1);
}

// --tmux requires --view
if (opts.tmux && !opts.view) {
  console.error('Error: --tmux requires --view <id>');
  console.error('Usage: flightfinder --headless --view <id> --tmux');
  process.exit(1);
}

if (opts.resetPassword || opts.disableAccounts) {
  // Break-glass account recovery for self hosted multi user mode. Talks to the
  // DB and exits; never renders ink or opens a browser. First branch so it can
  // never fall through to program.help().
  import('./lib/recovery-cli.js')
    .then(({ runResetPassword, runDisableAccounts }) => {
      if (opts.disableAccounts) return runDisableAccounts();
      if (!opts.resetPassword || !opts.newPassword) {
        console.error('Error: --reset-password <username> requires --new-password <password>');
        process.exit(1);
      }
      return runResetPassword(opts.resetPassword, opts.newPassword);
    })
    .catch((err) => {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
} else if (opts.json) {
  // Machine readable output for automation. Bypasses ink and the browser; the
  // helper prints to stdout and exits.
  import('./lib/json-output.js')
    .then(({ runJson }) => runJson({ view: opts.view }))
    .catch((err) => {
      console.error(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      process.exit(1);
    });
} else if (opts.headless) {
  // Terminal UI mode
  if (opts.view && opts.tmux) {
    launchTmuxView(opts.view).catch((err) => {
      console.error('tmux view failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
  } else {
    const mode = opts.list ? 'list' as const : opts.view ? 'view' as const : 'search' as const;
    const viewId = opts.view;
    render(<App mode={mode} viewId={viewId} />);
  }
} else if (opts.view) {
  // Open web view in browser
  const url = `${baseUrl}/q/${opts.view}`;
  console.log(`Opening ${url} in browser...`);
  import('child_process').then(({ exec }) => exec(`open "${url}"`));
} else if (opts.list) {
  // Open admin dashboard in browser
  const url = `${baseUrl}/admin/queries`;
  console.log(`Opening ${url} in browser...`);
  import('child_process').then(({ exec }) => exec(`open "${url}"`));
} else {
  // No flags — show help
  program.help();
}
