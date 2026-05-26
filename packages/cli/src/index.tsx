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
  .name('fairtrail')
  .description('The price trail airlines don\'t show you')
  .option('--headless', 'Terminal UI mode (required for CLI interaction)')
  .option('--list', 'Show all tracked queries (web) or with --headless (terminal)')
  .option('--view <id>', 'View price chart (web) or with --headless (terminal)')
  .option('--tmux', 'Split grouped routes into tmux panes (requires --headless --view)')
  .option('--backend <provider>', 'AI backend: claude-code, codex, anthropic, openai, google')
  .option('--model <model>', 'Model override (e.g. sonnet, opus, gpt-4.1-mini, codex)')
  .parse();

const opts = program.opts() as { headless?: boolean; list?: boolean; view?: string; tmux?: boolean; backend?: string; model?: string };

const baseUrl = process.env.FLIGHT_FINDER_URL
  ?? `http://localhost:${process.env.HOST_PORT ?? process.env.PORT ?? '3003'}`;

// Set backend/model override — update DB config so parse-query.ts and extract-prices.ts pick it up
if (opts.backend) {
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
  console.error('Usage: fairtrail --headless --view <id> --tmux');
  process.exit(1);
}

// --tmux requires --view
if (opts.tmux && !opts.view) {
  console.error('Error: --tmux requires --view <id>');
  console.error('Usage: fairtrail --headless --view <id> --tmux');
  process.exit(1);
}

if (opts.headless) {
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
