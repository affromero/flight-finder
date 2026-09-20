import { AccessService, HouseholdProfileService, accessStateSchema, initialAccessState } from 'thesidedoor-core/access';
import { OptimisticStateStore, type StateSnapshot } from 'thesidedoor-core/storage/optimistic';

/** Replace only persistence. Session verification and authorization use the shipped package. */
export function createAccessFixture() {
  let snapshot: StateSnapshot | null = null;
  const store = new OptimisticStateStore({
    initial: initialAccessState,
    parse: value => accessStateSchema.parse(value),
    backend: {
      async read() { return structuredClone(snapshot); },
      async compareAndSwap(previous, next) {
        if ((snapshot?.revision ?? null) !== previous) return false;
        snapshot = structuredClone(next);
        return true;
      },
    },
  });
  const access = new AccessService({ store, allowOpenHousehold: true });
  return {
    access,
    profiles: new HouseholdProfileService(access),
    reset() { snapshot = null; },
    async issue(id: string, owner = false) {
      return store.transact(state => {
        if (!state.principals.some(principal => principal.id === id)) state.principals.push({
          id, name: id, role: owner ? 'owner' : 'member', passwordHash: null, epoch: 0, createdAt: Date.now(),
        });
        return access.issueSession(state, id, 'Test browser');
      });
    },
  };
}

/** HTTP tests provide database rows and cookies while exercising real shared sessions. */
export function createRequestAccessFixture() {
  const fixture = createAccessFixture();
  let user: ({ id: string; isAdmin?: boolean } & Record<string, unknown>) | null = null;
  let token = '';
  return {
    ...fixture,
    get user() { return user; },
    get token() { return token; },
    async signIn(account: typeof user) {
      user = account;
      if (!account) { token = ''; return; }
      await fixture.access.store.transact(state => {
        const principal = state.principals.find(item => item.id === account.id);
        if (principal) { principal.role = account.isAdmin ? 'owner' : 'member'; principal.epoch++; }
      });
      token = await fixture.issue(account.id, account.isAdmin === true);
    },
    resetRequest() { fixture.reset(); user = null; token = ''; },
  };
}
