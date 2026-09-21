import { sharedAccess } from '@/lib/sidedoor/access/service';
import { prisma } from '@/lib/prisma';

/** Local integration-test fixture for an account already created in the disposable database. */
export async function createDatabaseSession(userId: string): Promise<string> {
  const users = await prisma.user.findMany();
  if (!users.some(user => user.id === userId)) throw new Error(`Integration-test user ${userId} does not exist`);
  return sharedAccess.store.transact(state => {
    for (const user of users) {
      const principal = state.principals.find(item => item.id === user.id);
      if (principal) principal.role = user.isAdmin ? 'owner' : 'member';
      else state.principals.push({
        id: user.id,
        name: user.username,
        role: user.isAdmin ? 'owner' : 'member',
        passwordHash: null,
        epoch: 0,
        createdAt: user.createdAt.getTime(),
      });
    }
    return sharedAccess.issueSession(state, userId, 'Integration test');
  });
}
