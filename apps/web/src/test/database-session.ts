import { sharedAccess } from '@/lib/sidedoor/access/service';

/** Local integration-test fixture for an account already created in the disposable database. */
export async function createDatabaseSession(userId: string): Promise<string> {
  return sharedAccess.store.transact(state => sharedAccess.issueSession(state, userId, 'Integration test'));
}
