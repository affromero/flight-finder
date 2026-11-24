import { describe, it, expect } from 'vitest';
import { renderBrailleChart, type ChartSeries } from '../lib/chart.js';

describe('renderBrailleChart', () => {
  const singleSeries: ChartSeries[] = [
    { label: 'United', points: [{ x: 1, y: 450 }, { x: 2, y: 420 }, { x: 3, y: 380 }] },
  ];

  const multiSeries: ChartSeries[] = [
    { label: 'United', points: [{ x: 1, y: 450 }, { x: 2, y: 420 }, { x: 3, y: 380 }] },
    { label: 'Delta', points: [{ x: 1, y: 520 }, { x: 2, y: 490 }, { x: 3, y: 470 }] },
  ];

  it('renders a chart with single series', () => {
    const output = renderBrailleChart(singleSeries, { width: 40, height: 6 });
    expect(output).toContain('┤');
    expect(output).toContain('└');
    // Y-axis labels should show price range
    expect(output).toMatch(/\d+/);
  });

  it('renders a chart with multiple series and legend', () => {
    const output = renderBrailleChart(multiSeries, { width: 40, height: 6 });
    expect(output).toContain('United');
    expect(output).toContain('Delta');
    // Legend dots
    expect(output).toContain('●');
  });

  it('handles empty data gracefully', () => {
    const output = renderBrailleChart([], { width: 40, height: 6 });
    expect(output).toContain('No data');
  });

  it('handles single-point series', () => {
    const series: ChartSeries[] = [
      { label: 'Test', points: [{ x: 1, y: 500 }] },
    ];
    const output = renderBrailleChart(series, { width: 40, height: 6 });
    expect(output).toContain('┤');
  });

  it('includes x-axis labels when provided', () => {
    const output = renderBrailleChart(singleSeries, {
      width: 60,
      height: 6,
      xLabels: ['Mon', 'Wed', 'Fri'],
    });
    expect(output).toContain('Mon');
    expect(output).toContain('Wed');
  });

  it('includes y-axis currency label', () => {
    const output = renderBrailleChart(singleSeries, {
      width: 40,
      height: 6,
      yLabel: '$',
    });
    expect(output).toContain('$');
  });

  it('scales Y-axis dynamically to price range', () => {
    const expensive: ChartSeries[] = [
      { label: 'First', points: [{ x: 1, y: 5000 }, { x: 2, y: 8000 }] },
    ];
    const cheap: ChartSeries[] = [
      { label: 'Budget', points: [{ x: 1, y: 50 }, { x: 2, y: 80 }] },
    ];
    const expOutput = renderBrailleChart(expensive, { width: 40, height: 6, yLabel: '$' });
    const cheapOutput = renderBrailleChart(cheap, { width: 40, height: 6, yLabel: '$' });

    // Expensive should show 5000-8000 range
    expect(expOutput).toMatch(/[5-8]\d{3}/);
    // Cheap should show 50-80 range
    expect(cheapOutput).toMatch(/\d{2}/);
    // They should be different
    expect(expOutput).not.toEqual(cheapOutput);
  });

  it('adapts to different widths', () => {
    const narrow = renderBrailleChart(singleSeries, { width: 30, height: 6 });
    const wide = renderBrailleChart(singleSeries, { width: 80, height: 6 });

    const narrowLines = narrow.split('\n');
    const wideLines = wide.split('\n');
    // Wide chart should have longer lines
    expect(wideLines[0]!.length).toBeGreaterThan(narrowLines[0]!.length);
  });

  it('handles constrained terminal widths without crashing', () => {
    expect(renderBrailleChart(singleSeries, { width: 10, height: 6 })).toContain('Terminal too small');
    expect(renderBrailleChart(singleSeries, { width: 8, height: 6 })).toContain('Terminal too small');
  });

  it('adapts to different heights', () => {
    const short = renderBrailleChart(singleSeries, { width: 40, height: 4 });
    const tall = renderBrailleChart(singleSeries, { width: 40, height: 10 });

    const shortLines = short.split('\n').filter((l) => l.includes('┤'));
    const tallLines = tall.split('\n').filter((l) => l.includes('┤'));
    expect(tallLines.length).toBeGreaterThan(shortLines.length);
  });

  it('handles minimal height without NaN labels', () => {
    const output = renderBrailleChart(singleSeries, { width: 40, height: 1 });
    expect(output).not.toContain('NaN');
    expect(output).toContain('┤');
  });

  it('uses braille characters for plotting', () => {
    const output = renderBrailleChart(singleSeries, { width: 40, height: 6 });
    // Braille block starts at U+2800
    const hasBraille = /[\u2800-\u28FF]/.test(output);
    expect(hasBraille).toBe(true);
  });

  it('handles identical Y values without crashing', () => {
    const flat: ChartSeries[] = [
      { label: 'Flat', points: [{ x: 1, y: 300 }, { x: 2, y: 300 }, { x: 3, y: 300 }] },
    ];
    const output = renderBrailleChart(flat, { width: 40, height: 6 });
    expect(output).toContain('┤');
  });

  it('handles negative Y values', () => {
    const neg: ChartSeries[] = [
      { label: 'Loss', points: [{ x: 1, y: -50 }, { x: 2, y: -20 }, { x: 3, y: 10 }] },
    ];
    const output = renderBrailleChart(neg, { width: 40, height: 6 });
    expect(output).toContain('┤');
  });
});
