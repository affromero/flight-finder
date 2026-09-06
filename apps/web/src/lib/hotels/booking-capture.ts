import type { Page } from 'playwright';

export async function captureBookingRates(page: Page) {
  return page.locator('table').evaluateAll(tables => tables.flatMap(table => {
    let roomName = '';
    let roomOccupancy = '';
    const priceBasis = Array.from(table.querySelectorAll('thead th'))
      .map(header => (header as HTMLElement).innerText.trim())
      .find(header => /\bPrice for \d+ nights?\b|\b(?:per|each) night\b|nightly/i.test(header));
    return Array.from(table.querySelectorAll('tr')).flatMap(row => {
      const name = row.querySelector('.hprt-roomtype-icon-link,.hprt-roomtype-link,[data-testid="room-name"]')?.textContent?.trim();
      if (name) {
        roomName = name;
        roomOccupancy = row.innerText.match(/Sleeps:\s*\d+ adults?(?:[^\n]*children?)?/i)?.[0] ?? '';
      }
      const select = row.querySelector<HTMLSelectElement>('select[name^="nr_rooms_"]');
      const occupancy = `${roomOccupancy}\n${[...row.querySelectorAll('[title],[aria-label]')].map(element => `${element.getAttribute('title') ?? ''} ${element.getAttribute('aria-label') ?? ''}`).join('\n')}`;
      return select ? [{ id: select.name.replace(/^nr_rooms_/, ''), roomName, text: row.innerText, occupancy, priceBasis, available: Math.max(...[...select.options].map(option => Number(option.value)).filter(Number.isFinite)) }] : [];
    });
  }));
}
