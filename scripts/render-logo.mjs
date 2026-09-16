// Renders assets/logo.svg into terminal art, and writes it to src/banner/logo.ts.
//
// A terminal cannot display an SVG, so the logo is re-rasterised here: the
// petals, core, prompt glyph and wordmark are drawn onto a subpixel grid that
// the runtime prints as quadrant blocks — `▘▝▀▖▌▞▛▗▚▐▜▄▙▟█` — four subpixels to
// a cell, carried by the cell's foreground and background colour.
//
// Quadrants rather than the more common half-block `▀` because a terminal cell
// is twice as tall as it is wide: splitting it only across the middle gives one
// sample per column, and a flower drawn a column at a time is a flower drawn
// out of dominoes. Splitting it four ways doubles the horizontal resolution at
// no cost in width, which is the axis the art is short of. The subpixels are
// then twice as tall as they are wide, so square geometry samples at 2:1.
//
// Run with `npm run logo` after changing assets/logo.svg.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'src', 'banner', 'logo.ts');

// Terminal columns the icon spans. It is square, so it is half that in rows.
//
// This is the one number that sets how much of the flower survives, and what it
// costs is the banner's total width — art wider than the terminal wraps every
// row at the terminal's own width and arrives as confetti, so the runtime drops
// to plain text below `LOGO_WIDTH` and the art is never seen at all. At 32 the
// whole banner lands at 87 columns, inside anything but a terminal still at the
// classic 80, and the flower has enough room for the notches between its petals
// to read as notches and for the core to hold a prompt that looks like `>_`.
const ICON = 32;
/** Columns between the icon and the wordmark. */
const GAP = 2;

/** Subpixels across the icon, and down it — see the 2:1 note above. */
const ICON_W = ICON * 2;
const ICON_H = ICON;

// ---------------------------------------------------------------- svg geometry

// The petal path from assets/logo.svg, as its two cubic segments.
const PETAL_SEGMENTS = [
  [
    [0, -14],
    [30, -22],
    [37, -62],
    [0, -84],
  ],
  [
    [0, -84],
    [-37, -62],
    [-30, -22],
    [0, -14],
  ],
];

const CORE_RADIUS = 26;

const PETAL_TOP = hex('#8B7BE8');
const PETAL_BOTTOM = hex('#5B47C2');
const PETAL_STROKE = hex('#4A38A8');
const CORE_INNER = hex('#FFD066');
const CORE_OUTER = hex('#F0A92E');
const PROMPT = hex('#3A2A14');
const VEIN = hex('#FFFFFF');

/** The SVG's vein opacity. */
const VEIN_ALPHA = 0.25;

// The SVG's veins are 2 units wide, which even here is under half a subpixel:
// sampled faithfully they only ever contributed speckle. Widened to about a
// subpixel they do the job they do in the SVG — a crease down each petal, which
// is most of what tells a viewer the five lobes are petals and not a star — and
// the low opacity keeps them from cutting the petal in two.
const VEIN_HALF_WIDTH = 1.6;

/** Marks a core sample, so a pixel can tell a petal seam from the core's edge. */
const CORE = -1;

// The SVG wordmark is near-black (#2B2440), which disappears on a dark
// terminal. The terminal build borrows the petal purple instead.
const WORDMARK = hex('#8B7BE8');

function hex(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function mix(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

function rotate(x, y, deg) {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);

  return [x * c - y * s, x * s + y * c];
}

function flattenBezier(segments, steps = 60) {
  const points = [];

  for (const [p0, p1, p2, p3] of segments) {
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      const x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0];
      const y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1];
      points.push([x, y]);
    }
  }

  return points;
}

const PETAL_POLYGON = flattenBezier(PETAL_SEGMENTS);

function inPolygon(x, y, polygon) {
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];

    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }

  return inside;
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length2 = dx * dx + dy * dy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / length2));

  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * The SVG's colour at one point in icon-local space (origin = flower centre),
 * with the part of the flower it belongs to.
 *
 * The 1-unit stroke the SVG puts around each petal is not sampled. Against a
 * petal fifty units across it is a fraction of a subpixel, so a faithful
 * reading loses it — and widening it enough to survive costs a subpixel off
 * every petal edge, which is most of what turns the flower into a blob. What
 * that stroke is load-bearing for, keeping one petal off the next, is done per
 * subpixel instead; see `samplePixel`.
 */
function sampleIcon(x, y) {
  if (Math.hypot(x, y) <= CORE_RADIUS) {
    // radialGradient cx=.35 cy=.3 r=1, in objectBoundingBox units over the
    // core's bounding box.
    const size = CORE_RADIUS * 2;
    const cx = -CORE_RADIUS + 0.35 * size;
    const cy = -CORE_RADIUS + 0.3 * size;

    return { color: mix(CORE_INNER, CORE_OUTER, Math.min(1, Math.hypot(x - cx, y - cy) / size)), part: CORE };
  }

  for (let k = 0; k < 5; k++) {
    // Un-rotated into the base petal's own space: the gradient rotates with the
    // petal, so it has to be evaluated before the 72-degree step is applied.
    const [lx, ly] = rotate(x, y, -72 * k);

    if (!inPolygon(lx, ly, PETAL_POLYGON)) {
      continue;
    }

    // linearGradient y1=0 -> y2=1 across the petal bbox, which spans y -84..-14.
    const color = mix(PETAL_TOP, PETAL_BOTTOM, Math.min(1, Math.max(0, (ly + 84) / 70)));
    const onVein = distanceToSegment(lx, ly, 0, -70, 0, -26) < VEIN_HALF_WIDTH;

    return { color: onVein ? mix(color, VEIN, VEIN_ALPHA) : color, part: k };
  }

  return null;
}

/** How much of a subpixel the flower has to cover before it is drawn at all. */
const COVERAGE = 0.5;

/** How far a subpixel two petals share is pulled towards the SVG's petal stroke. */
const SEAM = 0.5;

/**
 * One supersampled subpixel, or null where the flower covers too little of it.
 *
 * Coverage settles the silhouette outright instead of fading out into the
 * background, because the terminal's background colour is not knowable from
 * here. The one blend that does happen is on a subpixel two petals share: that
 * is where the SVG's stroke runs, and darkening it is what holds the petals
 * apart down near the core, where the gap between them closes to less than a
 * subpixel and they would otherwise sample as one shape.
 */
function samplePixel(cx, cy, stepX, stepY) {
  const N = 4;
  const petals = new Set();
  const core = { hits: 0, acc: [0, 0, 0] };
  const petal = { hits: 0, acc: [0, 0, 0] };

  for (let sy = 0; sy < N; sy++) {
    for (let sx = 0; sx < N; sx++) {
      const sample = sampleIcon(cx + (sx / N - 0.5 + 0.5 / N) * stepX, cy + (sy / N - 0.5 + 0.5 / N) * stepY);

      if (!sample) {
        continue;
      }

      const into = sample.part === CORE ? core : petal;

      into.hits++;
      into.acc = [into.acc[0] + sample.color[0], into.acc[1] + sample.color[1], into.acc[2] + sample.color[2]];

      if (sample.part !== CORE) {
        petals.add(sample.part);
      }
    }
  }

  if ((core.hits + petal.hits) / (N * N) < COVERAGE) {
    return null;
  }

  const average = ({ hits, acc }) => [acc[0] / hits, acc[1] / hits, acc[2] / hits];

  // The core is painted over the petals, and it only stays a disc if its edge
  // stays hard: averaging a shared subpixel gives the orange-into-purple
  // mid-tone a name — salmon — and a ring of it around the core reads as a
  // smudge rather than as an edge. The larger share takes the subpixel whole.
  if (core.hits >= petal.hits) {
    return average(core);
  }

  return petals.size > 1 ? mix(average(petal), PETAL_STROKE, SEAM) : average(petal);
}

/**
 * The prompt — chevron and cursor — stamped as whole subpixels rather than
 * sampled from the SVG's stroked paths. A 4.5-unit stroke downsampled into a
 * core this size lands as a brown smudge: legible as "something is there", not
 * as a prompt. Snapping it to the grid is what makes it read.
 *
 * The proportions are the SVG's, which is what the extra horizontal resolution
 * bought: a chevron a little over half as wide as it is tall, three subpixels
 * to a stroke so the diagonal joins rather than dots, and a cursor sitting off
 * its baseline to the right.
 */
const PROMPT_GLYPH = [
  '####..........',
  '..####........',
  '....####......',
  '......####....',
  '....####......',
  '..####........',
  '####....######',
];

function iconGrid() {
  const SPAN = 172; // the petals reach r=84, so this leaves a little air
  const stepX = SPAN / ICON_W;
  const stepY = SPAN / ICON_H;
  const grid = [];

  for (let py = 0; py < ICON_H; py++) {
    const row = [];

    for (let px = 0; px < ICON_W; px++) {
      row.push(samplePixel(-SPAN / 2 + (px + 0.5) * stepX, -SPAN / 2 + (py + 0.5) * stepY, stepX, stepY));
    }

    grid.push(row);
  }

  // Centred on the core rather than on the icon: they share an origin, but the
  // glyph has to land inside the core, where being a subpixel out puts a stroke
  // on the petal behind it. The core is a circle in the geometry and so an
  // ellipse on a grid of subpixels that are twice as tall as they are wide.
  const cx = ICON_W / 2 - 0.5;
  const cy = ICON_H / 2 - 0.5;
  const rx = CORE_RADIUS / stepX;
  const ry = CORE_RADIUS / stepY;
  // Floor, not round: an odd glyph against an even grid has no exact centre,
  // and half a subpixel up is the half that keeps the cursor's far corner
  // inside the core.
  const x0 = Math.floor(cx - (PROMPT_GLYPH[0].length - 1) / 2);
  const y0 = Math.floor(cy - (PROMPT_GLYPH.length - 1) / 2);
  let clipped = 0;

  for (let r = 0; r < PROMPT_GLYPH.length; r++) {
    for (let c = 0; c < PROMPT_GLYPH[r].length; c++) {
      if (PROMPT_GLYPH[r][c] !== '#') {
        continue;
      }

      const x = x0 + c;
      const y = y0 + r;

      // Clipped to the core, so a glyph that outgrows it loses the overhanging
      // subpixels instead of stamping them across the petals behind.
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) {
        grid[y][x] = PROMPT;
      } else {
        clipped++;
      }
    }
  }

  // Silent clipping is how the prompt quietly loses its cursor: the art still
  // renders, just without the part that carries the idea. Fail instead.
  if (clipped > 0) {
    throw new Error(
      `render-logo: ${clipped} prompt-glyph subpixel(s) fell outside the core. ` +
        `Raise CORE_RADIUS (currently ${CORE_RADIUS}) or ICON (currently ${ICON}), ` +
        'or narrow PROMPT_GLYPH.'
    );
  }

  return grid;
}

// ------------------------------------------------------------------- wordmark

/**
 * Subpixel rows per glyph: rows 0-2 are the ascender band, rows 3-9 the
 * x-height. A subpixel row is a whole cell-half tall, so this is 10 units of
 * height against the icon's 32 — near the ratio the SVG holds between its
 * wordmark and its flower.
 */
const GLYPH_HEIGHT = 10;

// Shaped after the SVG's Montserrat 700 rather than after what fits most easily.
// Three things carry that likeness at this size:
//
//   - Circular bowls. Because a subpixel is half a column wide, `o` is 14 of
//     them against a 7-row x-height — the same square, at twice the horizontal
//     resolution, which is what lets the bowl round off at the corners instead
//     of turning them.
//   - A large x-height with a short ascender. `d` rises only 3 rows above the
//     x-height; a taller ascender reads as a text face, not a wordmark.
//   - Flat-topped left stems on `r`, `n` and `m`, with the shoulder arching off
//     to the right. Rounding both sides turns `n` into a bin and `r` into a
//     clipped `n`.
//
// Stems are 4 subpixels, which is two columns — against a 7-row x-height that
// lands near the SVG's 700 weight.
const GLYPHS = {
  // Half the width of `o`, as the face has it, and it is also the column the
  // wordmark can least afford to spend: `m` is the letter that cannot be
  // condensed without breaking, so `r` is where the room comes from.
  r: [
    '........',
    '........',
    '........',
    '########',
    '####..##',
    '####....',
    '####....',
    '####....',
    '####....',
    '####....',
  ],
  a: [
    '............',
    '............',
    '............',
    '..########..',
    '........####',
    '..##########',
    '####....####',
    '####....####',
    '####....####',
    '..##########',
  ],
  // A single unbroken shoulder. Notching it between the arches — the obvious way
  // to suggest two of them — splits the letter and `m` reads as `rn`.
  m: [
    '....................',
    '....................',
    '....................',
    '##################..',
    '####################',
    '####....####....####',
    '####....####....####',
    '####....####....####',
    '####....####....####',
    '####....####....####',
  ],
  o: [
    '..............',
    '..............',
    '..............',
    '...########...',
    '.############.',
    '####......####',
    '####......####',
    '####......####',
    '.############.',
    '...########...',
  ],
  n: [
    '..............',
    '..............',
    '..............',
    '###########...',
    '#############.',
    '####......####',
    '####......####',
    '####......####',
    '####......####',
    '####......####',
  ],
  // The stem runs unbroken from the ascender to the baseline, so the bowl closes
  // against it at both ends rather than pinching the stem off.
  d: [
    '..........####',
    '..........####',
    '..........####',
    '...###########',
    '.#############',
    '####......####',
    '####......####',
    '####......####',
    '.#############',
    '...###########',
  ],
};

/** Subpixels between letters — one column. */
const TRACKING = 2;

function wordmarkGrid(text) {
  const rows = Array.from({ length: GLYPH_HEIGHT }, () => []);
  const chars = [...text];

  chars.forEach((ch, i) => {
    const glyph = GLYPHS[ch];

    if (!glyph) {
      throw new Error(`render-logo: no glyph for ${JSON.stringify(ch)}`);
    }

    if (glyph.length !== GLYPH_HEIGHT) {
      throw new Error(`render-logo: glyph ${JSON.stringify(ch)} is ${glyph.length} rows, expected ${GLYPH_HEIGHT}`);
    }

    for (let r = 0; r < GLYPH_HEIGHT; r++) {
      if (glyph[r].length !== glyph[0].length) {
        throw new Error(`render-logo: glyph ${JSON.stringify(ch)} row ${r} is a different width to its first row`);
      }

      for (const cell of glyph[r]) {
        rows[r].push(cell === '#' ? WORDMARK : null);
      }

      // Between letters only. A trailing column costs width the whole banner
      // has to fit inside, and buys nothing.
      if (i < chars.length - 1) {
        for (let t = 0; t < TRACKING; t++) {
          rows[r].push(null);
        }
      }
    }
  });

  return rows;
}

// --------------------------------------------------------------------- output

function compose() {
  const icon = iconGrid();
  const word = wordmarkGrid('ramonda');
  const wordWidth = word[0].length;
  const wordLeft = ICON_W + GAP * 2;
  const wordTop = Math.round((ICON_H - GLYPH_HEIGHT) / 2); // centred against the icon
  const width = wordLeft + wordWidth;
  const grid = [];

  for (let y = 0; y < ICON_H; y++) {
    const row = [];

    for (let x = 0; x < width; x++) {
      if (x < ICON_W) {
        row.push(icon[y][x]);
        continue;
      }

      const wx = x - wordLeft;
      const wy = y - wordTop;
      row.push(wx >= 0 && wx < wordWidth && wy >= 0 && wy < GLYPH_HEIGHT ? word[wy][wx] : null);
    }

    grid.push(row);
  }

  return grid;
}

/**
 * The xterm-256 palette that is safe to quantise into: the 6x6x6 colour cube
 * plus the 24-step grey ramp. Indices 0-15 are left out because terminals let
 * users redefine them, so the art cannot know what it would be asking for.
 */
const PALETTE_256 = (() => {
  const levels = [0, 95, 135, 175, 215, 255];
  const entries = [];

  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        entries.push({ index: 16 + 36 * r + 6 * g + b, rgb: [levels[r], levels[g], levels[b]] });
      }
    }
  }

  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    entries.push({ index: 232 + i, rgb: [v, v, v] });
  }

  return entries;
})();

/**
 * Nearest xterm-256 index, for terminals that do not advertise truecolor.
 *
 * Searched over the whole palette rather than rounded per channel. Independent
 * rounding sends a dark brown like the prompt's #3A2A14 to (95,0,0) — its red
 * channel is the only one that clears the cube's first step — which puts a
 * maroon smear where the prompt should be. The grey ramp is a far better match,
 * and only a whole-colour search can find it.
 */
function to256([r, g, b]) {
  let best = PALETTE_256[0];
  let bestDistance = Infinity;

  for (const entry of PALETTE_256) {
    const distance = (entry.rgb[0] - r) ** 2 + (entry.rgb[1] - g) ** 2 + (entry.rgb[2] - b) ** 2;

    if (distance < bestDistance) {
      bestDistance = distance;
      best = entry;
    }
  }

  return best.index;
}

/**
 * Quadrant blocks, indexed by which subpixels the foreground colour covers:
 * bit 1 top-left, 2 top-right, 4 bottom-left, 8 bottom-right. Every one of the
 * sixteen combinations has a character, so any way of splitting a cell in two
 * is drawable — which is what lets the encoder below pick the split on colour
 * rather than on what the alphabet happens to allow.
 */
const QUADRANTS = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█'];

function sumSquares(colors, mean) {
  let total = 0;

  for (const c of colors) {
    total += (c[0] - mean[0]) ** 2 + (c[1] - mean[1]) ** 2 + (c[2] - mean[2]) ** 2;
  }

  return total;
}

function meanColor(colors) {
  const acc = colors.reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]], [0, 0, 0]);

  return [acc[0] / colors.length, acc[1] / colors.length, acc[2] / colors.length];
}

/**
 * One cell: four subpixels in, a quadrant character with a foreground and at
 * most one background colour out.
 *
 * A cell can only hold two colours, so the four subpixels have to be split into
 * two groups and each group flattened to its mean. Which split that is gets
 * decided by trying all sixteen and keeping the one with the least squared
 * error, rather than by always cutting the cell the same way — a petal edge
 * running diagonally through a cell is served by `▚`, and the same cell cut
 * across the middle would smear both colours into a single muddy pair.
 *
 * A subpixel the flower does not cover is not a colour, though: it has to show
 * whatever the terminal's background is, which means it has to be in the group
 * that gets no background colour set. So a cell that is only partly covered has
 * its split forced, and everything drawn in it takes one colour.
 */
function ansiCell(quad, depth) {
  const drawn = quad.filter((c) => c !== null);

  if (drawn.length === 0) {
    return ' ';
  }

  const fg = (c) =>
    depth === 'truecolor' ? `\x1b[38;2;${c.map(Math.round).join(';')}m` : `\x1b[38;5;${to256(c.map(Math.round))}m`;
  const bg = (c) =>
    depth === 'truecolor' ? `\x1b[48;2;${c.map(Math.round).join(';')}m` : `\x1b[48;5;${to256(c.map(Math.round))}m`;

  if (drawn.length < 4) {
    const mask = quad.reduce((m, c, i) => (c === null ? m : m | (1 << i)), 0);

    return `${fg(meanColor(drawn))}${QUADRANTS[mask]}\x1b[0m`;
  }

  let best = { cost: Infinity };

  // Downwards, so that a tie goes to the largest foreground — a cell whose four
  // subpixels are one colour then comes out as a plain `█` with nothing in the
  // background, rather than as a quarter block over a background of the same
  // colour, which draws the same but leans on the terminal to agree about what
  // the other three quarters are.
  for (let mask = 15; mask >= 1; mask--) {
    const front = quad.filter((_, i) => mask & (1 << i));
    const back = quad.filter((_, i) => !(mask & (1 << i)));
    const frontMean = meanColor(front);
    const backMean = back.length > 0 ? meanColor(back) : null;
    const cost = sumSquares(front, frontMean) + (backMean ? sumSquares(back, backMean) : 0);

    if (cost < best.cost) {
      best = { cost, mask, frontMean, backMean };
    }
  }

  const painted = best.backMean ? `${fg(best.frontMean)}${bg(best.backMean)}` : fg(best.frontMean);

  return `${painted}${QUADRANTS[best.mask]}\x1b[0m`;
}

function toRows(grid, depth) {
  const rows = [];

  for (let y = 0; y < grid.length; y += 2) {
    let line = '';

    for (let x = 0; x < grid[y].length; x += 2) {
      const quad = [grid[y][x] ?? null, grid[y][x + 1] ?? null, grid[y + 1]?.[x] ?? null, grid[y + 1]?.[x + 1] ?? null];

      line += ansiCell(quad, depth);
    }

    rows.push(line.replace(/\s+$/, ''));
  }

  // The sampling span leaves air around the petals, which lands as blank rows at
  // the top and bottom. The banner adds its own spacing, so drop them here.
  while (rows.length > 0 && rows[0].trim() === '') {
    rows.shift();
  }

  while (rows.length > 0 && rows[rows.length - 1].trim() === '') {
    rows.pop();
  }

  return rows;
}

const grid = compose();
const width = Math.ceil(grid[0].length / 2);
const literal = (rows) => rows.map((r) => `  ${JSON.stringify(r)},`).join('\n');

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `// GENERATED by scripts/render-logo.mjs from assets/logo.svg — do not edit.
// Regenerate with \`npm run logo\`.

/** Columns the art occupies. Below this the banner falls back to plain text. */
export const LOGO_WIDTH = ${width};

/** Column the wordmark starts at, so a caption can be aligned under it. */
export const WORDMARK_COLUMN = ${ICON + GAP};

/** Quadrant-block rows, 24-bit colour. */
export const LOGO_TRUECOLOR: readonly string[] = [
${literal(toRows(grid, 'truecolor'))}
];

/** The same art quantised to the xterm-256 cube. */
export const LOGO_256: readonly string[] = [
${literal(toRows(grid, '256'))}
];
`,
  'utf8'
);

process.stdout.write(`wrote ${OUT} (${width} cols x ${grid.length / 2} rows)\n`);
