import chalk from 'chalk';

// Braille characters form a 2-wide × 4-tall dot grid per cell.
// Dot positions (bit index):
//   0  3
//   1  4
//   2  5
//   6  7
const BRAILLE_BASE = 0x2800;
const DOT_BITS = [
  [0x01, 0x08], // row 0
  [0x02, 0x10], // row 1
  [0x04, 0x20], // row 2
  [0x40, 0x80], // row 3
];

const SERIES_COLORS = [
  '#06b6d4', // cyan (primary)
  '#f59e0b', // amber
  '#10b981', // emerald
  '#ef4444', // red
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#f97316', // orange
  '#14b8a6', // teal
];

export interface ChartSeries {
  label: string;
  points: Array<{ x: number; y: number }>;
  color?: string;
}

export interface ChartOptions {
  width: number;
  height: number;
  yLabel?: string;
  xLabels?: string[];
}

export function renderBrailleChart(
  series: ChartSeries[],
  options: ChartOptions,
): string {
  const { width, height } = options;

  // Determine data bounds
  let minY = Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;

  for (const s of series) {
    for (const p of s.points) {
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
    }
  }

  if (!isFinite(minY) || !isFinite(maxY)) return '  No data';

  // Add 10% padding to Y
  const yPad = (maxY - minY) * 0.1 || 1;
  minY -= yPad;
  maxY += yPad;

  const yLabelWidth = 8;
  const chartCols = width - yLabelWidth - 2;
  const chartRows = height;

  if (chartCols <= 0 || chartRows <= 0) return '  Terminal too small';

  // Braille resolution: 2 dots per col, 4 dots per row
  const dotW = chartCols * 2;
  const dotH = chartRows * 4;

  // Grid: each cell tracks which series colored it
  // -1 = empty, >= 0 = series index
  const grid: Int8Array = new Int8Array(dotW * dotH).fill(-1);

  // Map data point to dot coordinates
  const xRange = maxX - minX || 1;
  const yRange = maxY - minY || 1;

  function toDot(x: number, y: number): [number, number] {
    const dx = Math.round(((x - minX) / xRange) * (dotW - 1));
    const dy = Math.round(((maxY - y) / yRange) * (dotH - 1)); // Y inverted
    return [
      Math.max(0, Math.min(dotW - 1, dx)),
      Math.max(0, Math.min(dotH - 1, dy)),
    ];
  }

  // Plot points and connect with lines (Bresenham)
  for (let si = 0; si < series.length; si++) {
    const pts = series[si]!.points
      .slice()
      .sort((a, b) => a.x - b.x)
      .map((p) => toDot(p.x, p.y));

    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i]!;
      grid[y0 * dotW + x0] = si;

      if (i > 0) {
        const [px, py] = pts[i - 1]!;
        // Bresenham's line
        const dx = Math.abs(x0 - px);
        const dy = -Math.abs(y0 - py);
        const sx = px < x0 ? 1 : -1;
        const sy = py < y0 ? 1 : -1;
        let err = dx + dy;
        let cx = px;
        let cy = py;
        while (cx !== x0 || cy !== y0) {
          grid[cy * dotW + cx] = si;
          const e2 = 2 * err;
          if (e2 >= dy) { err += dy; cx += sx; }
          if (e2 <= dx) { err += dx; cy += sy; }
        }
      }
    }
  }

  // Render braille characters
  const lines: string[] = [];

  for (let row = 0; row < chartRows; row++) {
    // Y-axis label
    const yVal = chartRows > 1 ? maxY - (row / (chartRows - 1)) * yRange : maxY;
    const label = (options.yLabel ?? '') + Math.round(yVal).toString();
    let line = chalk.dim(label.padStart(yLabelWidth)) + ' ┤';

    // Process each braille cell in this row
    for (let col = 0; col < chartCols; col++) {
      let codepoint = BRAILLE_BASE;
      let cellColor = -1;

      for (let dr = 0; dr < 4; dr++) {
        for (let dc = 0; dc < 2; dc++) {
          const dotY = row * 4 + dr;
          const dotX = col * 2 + dc;
          if (dotY < dotH && dotX < dotW) {
            const si = grid[dotY * dotW + dotX]!;
            if (si >= 0) {
              codepoint |= DOT_BITS[dr]![dc]!;
              cellColor = si;
            }
          }
        }
      }

      const char = String.fromCharCode(codepoint);
      if (cellColor >= 0) {
        const color = series[cellColor]?.color ?? SERIES_COLORS[cellColor % SERIES_COLORS.length]!;
        line += chalk.hex(color)(char);
      } else {
        line += chalk.dim(char);
      }
    }

    lines.push(line);
  }

  // X-axis
  const axisLine = ' '.repeat(yLabelWidth) + ' └' + '─'.repeat(chartCols);
  lines.push(chalk.dim(axisLine));

  // X-axis labels
  if (options.xLabels && options.xLabels.length > 0) {
    const labels = options.xLabels;
    let labelLine = ' '.repeat(yLabelWidth + 2);
    const spacing = Math.max(1, Math.floor(chartCols / (labels.length - 1 || 1)));
    for (let i = 0; i < labels.length; i++) {
      const pos = i * spacing;
      if (pos + labels[i]!.length <= chartCols) {
        while (labelLine.length < yLabelWidth + 2 + pos) labelLine += ' ';
        labelLine += chalk.dim(labels[i]!);
      }
    }
    lines.push(labelLine);
  }

  // Legend
  if (series.length > 1) {
    let legend = ' '.repeat(yLabelWidth + 2);
    for (let i = 0; i < series.length; i++) {
      const color = series[i]?.color ?? SERIES_COLORS[i % SERIES_COLORS.length]!;
      legend += chalk.hex(color)('●') + ' ' + chalk.dim(series[i]!.label) + '  ';
    }
    lines.push('');
    lines.push(legend);
  }

  return lines.join('\n');
}
