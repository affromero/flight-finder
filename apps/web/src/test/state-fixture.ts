import { OptimisticStateStore, type StateSnapshot } from 'thesidedoor-core/storage/optimistic';

/** Replace persistence while preserving real parsing, optimistic transactions and domain services. */
export function createStateBoundary() {
  const snapshots = new Map<string, StateSnapshot>();
  return {
    reset() { snapshots.clear(); },
    store<State>(id: string, parse: (value: unknown) => State, initial: () => State) {
      return new OptimisticStateStore({
        initial, parse,
        backend: {
          async read() { return structuredClone(snapshots.get(id) ?? null); },
          async compareAndSwap(previous, next) {
            if ((snapshots.get(id)?.revision ?? null) !== previous) return false;
            snapshots.set(id, structuredClone(next));
            return true;
          },
        },
      });
    },
  };
}
