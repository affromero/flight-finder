/** @vitest-environment jsdom */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TrackerLabel } from './TrackerLabel';

// No tracker is ever saved here, so getDeleteToken returns null — mirroring a
// browser that lost its localStorage delete token after a machine migration
// (issue #89). The canEdit prop is what gates the affordance in that case.
describe('TrackerLabel — edit affordance without a delete token', () => {
  it('shows the Add label button when canEdit is true even without a token', () => {
    render(<TrackerLabel queryId="q1" currentLabel={null} canEdit />);
    expect(screen.getByRole('button', { name: /add label/i })).toBeInTheDocument();
  });

  it('lets an authorized viewer edit an existing label without a token', () => {
    render(<TrackerLabel queryId="q1" currentLabel="Paris via Skyscanner" canEdit />);
    const label = screen.getByTitle(/click to edit/i);
    expect(label).toHaveTextContent('Paris via Skyscanner');
  });

  it('renders a read-only label (no edit button) when not authorized and no token', () => {
    render(<TrackerLabel queryId="q1" currentLabel="Paris via Google" canEdit={false} />);
    expect(screen.getByText('Paris via Google')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add label/i })).not.toBeInTheDocument();
    expect(screen.queryByTitle(/click to edit/i)).not.toBeInTheDocument();
  });

  it('renders nothing when unauthorized, tokenless, and unlabeled', () => {
    const { container } = render(<TrackerLabel queryId="q1" currentLabel={null} canEdit={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});
