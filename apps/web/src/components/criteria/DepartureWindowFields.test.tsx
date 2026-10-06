/** @vitest-environment jsdom */
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DepartureWindowFields } from './DepartureWindowFields';
import type { TimePreference } from '@/lib/criteria/departure';

function Fields() {
  const [preference, setPreference] = useState<TimePreference>('any');
  const [strict, setStrict] = useState(false);
  return <DepartureWindowFields timePreference={preference} strictDepartureTime={strict}
    onChange={(value, enabled) => { setPreference(value); setStrict(enabled); }} />;
}

describe('explicit departure-window choice', () => {
  it('starts unrestricted, permits opt-in and clears strictness when any time is selected', () => {
    render(<Fields />);
    const window = screen.getByRole('combobox', { name: 'Outbound departure window' });
    const strict = screen.getByRole('checkbox', { name: 'Only include flights in this window' });
    expect(strict).toBeDisabled();
    expect(strict).not.toBeChecked();
    fireEvent.change(window, { target: { value: 'morning' } });
    expect(strict).toBeEnabled();
    expect(strict).not.toBeChecked();
    fireEvent.click(strict);
    expect(strict).toBeChecked();
    fireEvent.change(window, { target: { value: 'afternoon' } });
    expect(strict).toBeChecked();
    fireEvent.change(window, { target: { value: 'any' } });
    expect(strict).not.toBeChecked();
    expect(strict).toBeDisabled();
    expect(screen.getByText(/local to the departure airport/)).toBeVisible();
    expect(screen.getByText(/unknown departure times are excluded/)).toBeVisible();
  });
});
