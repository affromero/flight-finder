import { execSync, spawnSync, spawn } from 'child_process';
import { prisma } from '@/lib/prisma';
import { resolve } from 'node:path';

const SESSION_NAME = 'flightfinder-view';

function tmux(...args: string[]): string {
  const result = spawnSync('tmux', args, { encoding: 'utf-8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || 'tmux command failed');
  }
  return result.stdout.trim();
}

function hasTmux(): boolean {
  try {
    execSync('tmux -V', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function hasGhostty(): boolean {
  try {
    execSync('which ghostty', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function buildViewCommand(queryId: string): string {
  const entrypoint = process.argv[1];
  if (!entrypoint) throw new Error('Cannot determine the CLI entrypoint for tmux');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  // Reuse this invocation, including its source loader or installed bundle.
  // The parent already saved any explicit backend/model selection.
  const args = [process.execPath, ...process.execArgv, resolve(entrypoint), '--headless', '--view', queryId];
  return `cd ${quote(process.cwd())} && ${args.map(quote).join(' ')}`;
}

function paneEnvironment(): string[] {
  // tmux's server can predate the caller's injected configuration. Pass it at
  // the process boundary, never as commands visible in a pane's shell history.
  const terminalKeys = new Set(['TMUX', 'TMUX_PANE', 'TERM', 'TERMCAP', 'LINES', 'COLUMNS']);
  return Object.entries(process.env).flatMap(([key, value]) =>
    value === undefined || terminalKeys.has(key) ? [] : ['-e', `${key}=${value}`]);
}

function currentSession(): string {
  return tmux('display-message', '-p', '#{session_name}');
}

function currentWindow(): string {
  return tmux('display-message', '-p', '#{window_index}');
}

function currentPane(): string {
  return tmux('display-message', '-p', '#{pane_index}');
}

export async function launchTmuxView(queryId: string): Promise<void> {
  try {
    if (!hasTmux()) {
      throw new Error('tmux is required for --tmux mode. Install tmux and retry.');
    }

    const query = await prisma.query.findUnique({ where: { id: queryId } });
    if (!query) {
      throw new Error(`Query "${queryId}" not found`);
    }

    let queries = [query];
    if (query.groupId) {
      queries = await prisma.query.findMany({
        where: { groupId: query.groupId },
        orderBy: { createdAt: 'asc' },
      });
    }

    console.log(`Found ${queries.length} route(s)...`);
    for (const q of queries) {
      console.log(`  ${q.origin} → ${q.destination}  (${q.dateFrom.toISOString().slice(0, 10)})`);
    }

    if (process.env.TMUX) {
      // Inside tmux — create NEW panes for ALL queries (never send to own pane)
      const session = currentSession();
      const win = currentWindow();
      const origPane = currentPane();

      // Split a new pane for each query, send commands there
      for (let i = 0; i < queries.length; i++) {
        const q = queries[i]!;
        const cmd = buildViewCommand(q.id);
        const title = `${q.origin}→${q.destination} ${q.dateFrom.toISOString().slice(0, 10)}`;
        const splitDir = i % 2 === 0 ? '-v' : '-h';
        tmux('split-window', ...paneEnvironment(), splitDir, '-t', `${session}:${win}`);
        tmux('select-pane', '-T', title);
        tmux('send-keys', cmd, 'Enter');
      }

      // Kill the original pane (the one running this command)
      // It's the pane that launched --tmux and is about to exit anyway
      tmux('select-layout', '-t', `${session}:${win}`, 'tiled');

      // Use kill-pane after a delay so this process can exit cleanly
      setTimeout(() => {
        try { tmux('kill-pane', '-t', `${session}:${win}.${origPane}`); } catch { /* ok */ }
      }, 500);

      console.log(`Opened ${queries.length} panes`);
    } else {
      // Outside tmux — create a new session and open in Ghostty
      try { tmux('kill-session', '-t', SESSION_NAME); } catch { /* ok */ }

      tmux('new-session', ...paneEnvironment(), '-d', '-s', SESSION_NAME, '-x', '220', '-y', '55');

      const q0 = queries[0]!;
      const firstCmd = buildViewCommand(q0.id);
      const title0 = `${q0.origin}→${q0.destination} ${q0.dateFrom.toISOString().slice(0, 10)}`;
      tmux('select-pane', '-t', `${SESSION_NAME}:0.0`, '-T', title0);
      tmux('send-keys', '-t', `${SESSION_NAME}:0.0`, firstCmd, 'Enter');

      for (let i = 1; i < queries.length; i++) {
        const q = queries[i]!;
        const cmd = buildViewCommand(q.id);
        const title = `${q.origin}→${q.destination} ${q.dateFrom.toISOString().slice(0, 10)}`;
        const splitDir = i % 2 === 1 ? '-h' : '-v';
        tmux('split-window', ...paneEnvironment(), splitDir, '-t', `${SESSION_NAME}:0`);
        tmux('select-pane', '-T', title);
        tmux('send-keys', '-t', `${SESSION_NAME}:0.${i}`, cmd, 'Enter');
      }

      tmux('select-layout', '-t', `${SESSION_NAME}:0`, 'tiled');
      tmux('select-pane', '-t', `${SESSION_NAME}:0.0`);

      if (hasGhostty()) {
        spawn('ghostty', ['-e', 'tmux', 'attach-session', '-t', SESSION_NAME], {
          detached: true,
          stdio: 'ignore',
        }).unref();
        console.log(`Opened Ghostty window with ${queries.length} panes`);
      } else {
        const result = spawnSync('tmux', ['attach-session', '-t', SESSION_NAME], { stdio: 'inherit' });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error('tmux attach-session failed');
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}
