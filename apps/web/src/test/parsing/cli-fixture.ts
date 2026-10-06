import { prisma } from '@/lib/prisma';
import { serializable } from '@/lib/sidedoor/access/transaction';
import { providerVault } from '@/lib/sidedoor/providers/provider-credentials';
import { FlightFinderAccessStore } from '@/lib/sidedoor/access/access-store';
import { parseLocally } from '../../../../../packages/cli/src/lib/parsing/local';

async function main() {
  const database = new URL(process.env.DATABASE_URL ?? '');
  if (database.hostname !== '127.0.0.1' || database.port !== '55448' || database.pathname !== '/parse_browser_test')
    throw Error('CLI parsing requires the disposable parse_browser_test fixture');
  const endpoint = process.argv[2];
  if (!endpoint || new URL(endpoint).hostname !== '127.0.0.1') throw Error('Missing local provider fixture');
  const state = await new FlightFinderAccessStore().read();
  const owners = state.principals.filter(principal => principal.role === 'owner');
  if (owners.length !== 1) throw Error('Missing canonical fixture owner');
  await serializable(async tx => {
    await tx.parseJob.deleteMany(); await tx.parseReservation.deleteMany(); await tx.apiUsageLog.deleteMany();
    await tx.extractionConfig.update({ where: { id: 'singleton' }, data: { provider: 'ollama', model: 'fixture', customBaseUrl: null, enabled: false } });
    await providerVault(tx).vault.configure('ollama', { baseUrl: endpoint });
  });
  if (process.argv[3] === 'cancel-completed') {
    const controller = new AbortController();
    try {
      await parseLocally({ query: 'JFK to LAX cancelled before acceptance' }, controller.signal,
        job => { if (job?.status === 'completed') controller.abort(); });
      throw Error('Cancelled completion was accepted');
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'AbortError') throw error;
      console.log(JSON.stringify({ cancelledBeforeAcceptance: true }));
      return;
    }
  }
  console.log(JSON.stringify({ ownerId: owners[0]!.id }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
