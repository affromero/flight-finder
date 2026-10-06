/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useTrackerChartView } from './view';

function Controls({ id, name }: { id: string; name: string }) {
  const view = useTrackerChartView(id);
  return <>
    <label>{name} grouping<select value={view.grouping} onChange={() => view.setGrouping('flight')}><option value="airline">Airline</option><option value="flight">Flight</option></select></label>
    <label>{name} flight<input type="checkbox" checked={!view.hidden.includes('flight-one')} onChange={() => view.toggle('flight-one')} /></label>
    <button onClick={view.showAll}>{name} restore</button>
  </>;
}

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

describe('tracker chart preferences', () => {
  it('shares explicit choices with sibling views and restores them after remounting', () => {
    const initial = render(<><Controls id="tracker-one" name="chart" /><Controls id="tracker-one" name="history" /><Controls id="tracker-two" name="other" /></>);
    expect(screen.getByLabelText('chart grouping')).toHaveValue('airline');
    fireEvent.change(screen.getByLabelText('chart grouping'), { target: { value: 'flight' } });
    fireEvent.click(screen.getByLabelText('history flight'));
    expect(screen.getByLabelText('chart flight')).not.toBeChecked();
    expect(screen.getByLabelText('history grouping')).toHaveValue('flight');
    expect(screen.getByLabelText('other flight')).toBeChecked();
    initial.unmount();
    render(<Controls id="tracker-one" name="reloaded" />);
    expect(screen.getByLabelText('reloaded grouping')).toHaveValue('flight');
    expect(screen.getByLabelText('reloaded flight')).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'reloaded restore' }));
    expect(screen.getByLabelText('reloaded flight')).toBeChecked();
  });

  it.each(['bad json', '{"grouping":"flight","hidden":[7]}', 'null'])('ignores malformed stored preferences: %s', (raw) => {
    localStorage.setItem('ft-chart-view:tracker-one', raw);
    render(<Controls id="tracker-one" name="chart" />);
    expect(screen.getByLabelText('chart grouping')).toHaveValue('airline');
    expect(screen.getByLabelText('chart flight')).toBeChecked();
  });

  it('keeps display choices usable when browser storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage disabled'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage disabled'); });
    render(<><Controls id="tracker-one" name="chart" /><Controls id="tracker-one" name="history" /></>);
    fireEvent.change(screen.getByLabelText('chart grouping'), { target: { value: 'flight' } });
    fireEvent.click(screen.getByLabelText('chart flight'));
    expect(screen.getByLabelText('history grouping')).toHaveValue('flight');
    expect(screen.getByLabelText('history flight')).not.toBeChecked();
  });

  it('does not carry a previous tracker selection into another tracker', () => {
    const view = render(<Controls id="tracker-one" name="chart" />);
    fireEvent.click(screen.getByLabelText('chart flight'));
    view.rerender(<Controls id="tracker-two" name="chart" />);
    expect(screen.getByLabelText('chart flight')).toBeChecked();
    expect(screen.getByLabelText('chart grouping')).toHaveValue('airline');
  });
});
