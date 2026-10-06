import React from 'react';
import { render } from 'ink';
import { App } from '../../app.js';
import { CliParseSession } from './session.js';

export async function runAsyncWizard(): Promise<void> {
  const session = new CliParseSession();
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= session.stop().catch(() => { console.error('Could not confirm parsing cancellation. Inspect async parsing recovery.'); process.exitCode = 1; })
      .finally(() => instance.unmount());
  };
  const instance = render(<App mode="search" parseSession={session} onExit={stop} />, { exitOnCtrlC: false });
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { await instance.waitUntilExit(); await stopping; }
  finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    await session.stop();
    const { prisma } = await import('@/lib/prisma'); await prisma.$disconnect();
  }
}
