import { claimParseJob } from '@/lib/parsing/jobs';
import { executeNextParse } from '@/lib/parsing/executor';
import { prisma } from '@/lib/prisma';

async function main() {
  try {
    const result = process.argv[2] === 'claim' ? await claimParseJob() : await executeNextParse();
    process.send?.({ claimed: typeof result === 'boolean' ? result : result?.job.id ?? null });
  } finally {
    await prisma.$disconnect();
    process.disconnect?.();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
