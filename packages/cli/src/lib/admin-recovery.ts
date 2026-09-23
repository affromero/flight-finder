// Self-contained stub. At build time tsup's `@` -> apps/web/src alias swaps in
// the real apps/web/src/lib/admin-recovery.ts, so this file is never in the
// bundle. It exists only so the CLI's own `tsc` (paths `@/*` -> ./src/*) and the
// dev loader can resolve the import; tests mock it. Same shim pattern as
// ./prisma.ts. If this ever runs, the build wiring is wrong.
export type ResetPasswordResult =
  | { ok: true }
  | { ok: false; error: string };

const STUB_MESSAGE = 'admin-recovery stub: only valid in the bundled build';

export async function resetSharedPassword(newPassword: string): Promise<ResetPasswordResult> {
  void newPassword;
  throw new Error(STUB_MESSAGE);
}

export async function disableMultiUserMode(): Promise<void> {
  throw new Error(STUB_MESSAGE);
}
