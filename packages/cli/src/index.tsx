#!/usr/bin/env node
// Use Commander's named export in both source and bundled entrypoints.
import { program } from 'commander';
import { render } from 'ink';
import React from 'react';
import { App } from './app.js';
import { launchTmuxView } from './lib/tmux-view.js';
import { registerHotelCommands } from './lib/hotel-cli.js';
import { registerCarCommands } from './lib/car-cli.js';

const hotelCommandHandled = registerHotelCommands(program);
const carCommandHandled = registerCarCommands(program);

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
  .action(runFlightCommand);


async function runFlightCommand(): Promise<void> {
  const opts = program.opts<{ headless?: boolean; list?: boolean; view?: string; tmux?: boolean; json?: boolean; backend?: string; model?: string; resetPassword?: string; newPassword?: string; disableAccounts?: boolean }>();
  try {
    if (opts.tmux && !opts.headless) throw new Error('--tmux requires --headless mode');
    if (opts.tmux && !opts.view) throw new Error('--tmux requires --view <id>');
    if (opts.resetPassword && !opts.disableAccounts && !opts.newPassword) {
      throw new Error('--reset-password <username> requires --new-password <password>');
    }

    // Recovery must never change model configuration as a side effect.
    if (opts.resetPassword || opts.disableAccounts) {
      const { runResetPassword, runDisableAccounts } = await import('./lib/recovery-cli.js');
      if (opts.disableAccounts) await runDisableAccounts();
      else await runResetPassword(opts.resetPassword!, opts.newPassword!);
      return;
    }

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
      const { prisma } = await import('@/lib/prisma');
      try {
        await prisma.extractionConfig.upsert({
          where: { id: 'singleton' },
          update: { provider: opts.backend, model },
          create: { id: 'singleton', provider: opts.backend, model, enabled: true, scrapeInterval: 3 },
        });
      } finally {
        await prisma.$disconnect();
      }
    }

    if (opts.json) {
      const { runJson } = await import('./lib/json-output.js');
      await runJson({ view: opts.view });
      return;
    }
    if (opts.headless) {
      if (opts.view && opts.tmux) await launchTmuxView(opts.view);
      else {
        const mode = opts.list ? 'list' as const : opts.view ? 'view' as const : 'search' as const;
        render(<App mode={mode} viewId={opts.view} />);
      }
      return;
    }
    if (opts.view || opts.list) {
      const baseUrl = process.env.FLIGHT_FINDER_URL
        ?? `http://localhost:${process.env.HOST_PORT ?? process.env.PORT ?? '3003'}`;
      const url = opts.view ? `${baseUrl}/q/${encodeURIComponent(opts.view)}` : `${baseUrl}/admin/queries`;
      console.log(`Opening ${url} in browser...`);
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      await promisify(execFile)('open', [url]);
      return;
    }
    program.help();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(opts.json ? JSON.stringify({ error: message }) : `Error: ${message}`);
    process.exitCode = 1;
  }
}

await program.parseAsync();
if (hotelCommandHandled() || carCommandHandled()) process.exit(process.exitCode ?? 0);
