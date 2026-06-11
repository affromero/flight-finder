/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ProfileMenu } from './ProfileMenu';

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

const ADMIN = { username: 'admin', displayName: null, avatar: 'paper-plane', isAdmin: true };
const MEMBER = { username: 'kid', displayName: 'Kid', avatar: 'globe', isAdmin: false };

function openMenu() {
  fireEvent.click(screen.getByRole('button', { expanded: false }));
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ProfileMenu', () => {
  it('is closed until the avatar is clicked', () => {
    render(<ProfileMenu user={ADMIN} />);
    expect(screen.queryByRole('menuitem', { name: 'Log out' })).toBeNull();
    openMenu();
    expect(screen.getByRole('menuitem', { name: 'Log out' })).toBeTruthy();
  });

  it('shows Connect a device and account items for any member', () => {
    render(<ProfileMenu user={MEMBER} />);
    openMenu();
    expect(screen.getByRole('menuitem', { name: 'Your trackers' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Account & appearance' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Connect a device' })).toBeTruthy();
  });

  it('hides admin-only destinations from non-admin members', () => {
    render(<ProfileMenu user={MEMBER} />);
    openMenu();
    expect(screen.queryByRole('menuitem', { name: 'Instance settings' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Manage household' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Admin dashboard' })).toBeNull();
  });

  it('exposes admin destinations to an admin', () => {
    render(<ProfileMenu user={ADMIN} />);
    openMenu();
    expect(screen.getByRole('menuitem', { name: 'Instance settings' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Manage household' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Admin dashboard' })).toBeTruthy();
  });

  it('Switch user logs out via the auth endpoint', async () => {
    render(<ProfileMenu user={MEMBER} />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Switch user' }));
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' }));
    });
  });
});
