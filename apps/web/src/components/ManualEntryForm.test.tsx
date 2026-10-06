/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ManualEntryForm, type ManualFormValues } from './ManualEntryForm';

function makeInitialValues(): ManualFormValues {
  return {
    origin: { code: 'MAN', name: 'Manchester (Manchester Airport)' },
    destination: { code: 'HRG', name: 'Hurghada (Hurghada International Airport)' },
    dateFrom: '2026-05-07',
    dateTo: '2026-05-21',
    tripType: 'round_trip',
    flexibility: 0,
    maxPrice: '',
    maxStops: '',
    maxDuration: '',
    airlines: '',
    timePreference: 'any',
    cabinClass: 'economy',
    currency: '',
  };
}

describe('ManualEntryForm — edit flow (issue #60)', () => {
  it('submits explicit strictness and preserves it when editing the manual draft', () => {
    const submit = vi.fn();
    const initial = { ...makeInitialValues(), dateFrom: '2099-05-07', dateTo: '2099-05-21', timePreference: 'morning' as const };
    const first = render(<ManualEntryForm onSubmit={submit} onCancel={vi.fn()} adminCurrency={null} initialValues={initial} />);
    const checkbox = screen.getByRole('checkbox', { name: 'Only include flights in this window' });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: 'Show available flights' }));
    const [parsed, , saved] = submit.mock.calls[0]!;
    expect(parsed).toMatchObject({ timePreference: 'morning', strictDepartureTime: true });
    expect(saved).toMatchObject({ timePreference: 'morning', strictDepartureTime: true });
    first.unmount();
    render(<ManualEntryForm onSubmit={submit} onCancel={vi.fn()} adminCurrency={null} initialValues={saved} />);
    expect(screen.getByRole('checkbox', { name: 'Only include flights in this window' })).toBeChecked();
  });
  beforeEach(() => {
    // jsdom does not implement fetch; AirportCombobox calls /api/airports.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: [] }),
    }));
  });

  it('keeps both origin and destination resolved when re-mounting with initialValues', () => {
    render(
      <ManualEntryForm
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        adminCurrency={null}
        initialValues={makeInitialValues()}
      />,
    );

    const origin = screen.getByRole('combobox', { name: /origin/i }) as HTMLInputElement;
    const destination = screen.getByRole('combobox', { name: /destination/i }) as HTMLInputElement;

    // Both fields should display the resolved IATA-prefixed value.
    expect(destination.value).toBe('HRG - Hurghada (Hurghada International Airport)');
    expect(origin.value).toBe('MAN - Manchester (Manchester Airport)');

    // Neither should be flagged invalid on mount.
    expect(origin.getAttribute('aria-invalid')).not.toBe('true');
    expect(destination.getAttribute('aria-invalid')).not.toBe('true');
  });
});
