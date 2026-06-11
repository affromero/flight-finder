/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ThemePicker } from './ThemePicker';

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme');
});
afterEach(cleanup);

describe('ThemePicker', () => {
  it('selecting a family keeps the current mode and emits family-mode', () => {
    const onSelect = vi.fn();
    render(<ThemePicker value="tron-dark" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Cyberpunk/ }));
    expect(onSelect).toHaveBeenCalledWith('cyberpunk-dark');
  });

  it('flipping to Light keeps the current family', () => {
    const onSelect = vi.fn();
    render(<ThemePicker value="tron-dark" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: '☀ Light' }));
    expect(onSelect).toHaveBeenCalledWith('tron-light');
  });

  it('applies the chosen theme to <html data-theme> for a live preview', () => {
    render(<ThemePicker value="tron-dark" onSelect={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Solar/ }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('solar-dark');
  });

  it('renders a follow-default escape hatch only when defaultOption is given', () => {
    const onDefault = vi.fn();
    const { rerender } = render(<ThemePicker value="tron-dark" onSelect={() => {}} />);
    expect(screen.queryByText(/instance default/i)).toBeNull();

    rerender(
      <ThemePicker value={null} onSelect={() => {}} defaultOption={{ active: true, onSelect: onDefault }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /instance default/i }));
    expect(onDefault).toHaveBeenCalled();
  });
});
