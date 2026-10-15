import type { Page } from 'playwright';

export async function captureBookingRating(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const ratings = new Set<number>();
    const visible = (element: Element): boolean => element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && !element.closest('[hidden],[aria-hidden="true"]');
    const visibleText = (element: Element): string => {
      const parts: string[] = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement && visible(node.parentElement)) parts.push(node.textContent ?? '');
      }
      return parts.join(' ');
    };
    const add = (value: string | null | undefined): void => {
      if (!value || !/^\d+(?:\.\d+)?$/.test(value.trim())) return;
      const rating = Number(value);
      if (rating > 0 && rating <= 10) ratings.add(rating);
    };
    const widgets = document.querySelectorAll<HTMLElement>('#js--hp-gallery-scorecard[data-review-score], #reviewFloater [data-testid="review-score-right-component"], [data-capla-component-boundary$="/PropertyReviewScoreRight"] [data-testid="review-score-right-component"]');
    for (const widget of widgets) {
      if (!visible(widget)) continue;
      if (widget.id === 'js--hp-gallery-scorecard') {
        add(widget.getAttribute('data-review-score'));
        continue;
      }
      for (const summary of [widget.getAttribute('aria-label') ?? '', visibleText(widget)]) {
        add(summary.match(/\bRated:[\s\S]*?\b(\d+(?:\.\d+)?)\s*,\s*based on [\d,]+\s+reviews?\b/i)?.[1]);
      }
      for (const element of [widget, ...widget.querySelectorAll('[aria-label]')]) {
        if (visible(element)) add(element.getAttribute('aria-label')?.match(/^Scored\s+(\d+(?:\.\d+)?)\s*$/i)?.[1]);
      }
    }
    const rating = [...ratings][0];
    return ratings.size === 1 && rating !== undefined ? `Scored ${rating}` : undefined;
  });
}

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
        roomOccupancy = row.innerText.match(/(?:Sleeps|Guests):\s*\d+ adults?(?:[^\n]*children?)?/i)?.[0] ?? '';
      }
      const select = row.querySelector<HTMLSelectElement>('select[name^="nr_rooms_"]');
      const occupancy = `${roomOccupancy}\n${[...row.querySelectorAll('[title],[aria-label]')].map(element => `${element.getAttribute('title') ?? ''} ${element.getAttribute('aria-label') ?? ''}`).join('\n')}`;
      return select ? [{ id: select.name.replace(/^nr_rooms_/, ''), roomName, text: row.innerText, occupancy, priceBasis, available: Math.max(...[...select.options].map(option => Number(option.value)).filter(Number.isFinite)) }] : [];
    });
  }));
}
