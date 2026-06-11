// The settings page is a client component, so it can't declare route config
// itself. Force dynamic rendering here so the root layout runs per-request and
// renders the viewer's real theme into <html> -- otherwise this route is
// statically prerendered at build time with the default theme baked in, and it
// visibly mismatches every other (dynamic) page.
export const dynamic = 'force-dynamic';

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
