import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockUpdateMany } = vi.hoisted(() => ({ mockUpdateMany: vi.fn() }));

vi.mock('@/lib/prisma', () => ({
  prisma: { query: { updateMany: mockUpdateMany } },
}));

import { expireDepartedQueries } from './expire-queries';

interface UpdateManyArgs {
  where: { active: boolean; isSeed: boolean; dateFrom: { lt: Date } };
  data: { active: boolean };
}

describe('expireDepartedQueries', () => {
  beforeEach(() => mockUpdateMany.mockReset());

  it('deactivates only active non seed trackers whose departure day has passed', async () => {
    mockUpdateMany.mockResolvedValue({ count: 3 });

    const count = await expireDepartedQueries();
    expect(count).toBe(3);

    const args = mockUpdateMany.mock.calls[0]![0] as UpdateManyArgs;
    expect(args.where.active).toBe(true);
    expect(args.where.isSeed).toBe(false);
    expect(args.data.active).toBe(false);

    // Cutoff is midnight UTC today, so a tracker departing today is not swept.
    const cutoff = args.where.dateFrom.lt;
    expect(cutoff).toBeInstanceOf(Date);
    expect(cutoff.getUTCHours()).toBe(0);
    expect(cutoff.getUTCMinutes()).toBe(0);
    expect(cutoff.getUTCSeconds()).toBe(0);
    expect(cutoff.getUTCMilliseconds()).toBe(0);
  });

  it('returns zero when nothing has departed', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });
    expect(await expireDepartedQueries()).toBe(0);
  });
});
