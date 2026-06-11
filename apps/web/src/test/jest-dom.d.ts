import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

// jest-dom 6.9.1 augments `vitest`'s Assertion, but vitest 4.1 resolves
// expect() to the Assertion in `@vitest/expect`, so the matcher types must be
// declared there for tsc to see them. The runtime matchers are still
// registered in setup-dom.ts via a guarded dynamic import.
//
// The interfaces are intentionally empty: they merge jest-dom's matchers into
// vitest's assertion types, which is the whole purpose of the augmentation.
declare module '@vitest/expect' {
  /* eslint-disable @typescript-eslint/no-empty-object-type */
  interface Assertion<T = unknown> extends TestingLibraryMatchers<unknown, T> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<unknown, unknown> {}
  /* eslint-enable @typescript-eslint/no-empty-object-type */
}
