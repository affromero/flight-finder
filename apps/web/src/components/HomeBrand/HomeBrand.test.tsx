/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { HomeBrand } from './HomeBrand';
import { usePathname } from 'next/navigation';

vi.mock('next/navigation', () => ({ usePathname: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

afterEach(cleanup);

describe('HomeBrand', () => {
  it.each(['/account', '/', '/hotels', '/hotels/saved-stay'])('provides a home link on %s', (path) => {
    vi.mocked(usePathname).mockReturnValue(path);
    render(<HomeBrand />);
    expect(screen.getByRole('link', { name: /Flight Finder home/i })).toHaveAttribute('href', '/');
  });

  it.each(['/admin', '/admin/users', '/setup', '/login'])(
    'hides itself on %s (own brand or pre-home flow)',
    (path) => {
      vi.mocked(usePathname).mockReturnValue(path);
      const { container } = render(<HomeBrand />);
      expect(container.firstChild).toBeNull();
    },
  );
});
