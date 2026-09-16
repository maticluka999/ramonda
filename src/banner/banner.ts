import { out } from '../utils/out.js';
import { VERSION } from '../utils/version.js';
import { LOGO_256, LOGO_TRUECOLOR, LOGO_WIDTH, WORDMARK_COLUMN } from './logo.js';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/**
 * How much colour the terminal will accept. The art is pre-rendered at both
 * depths, so this only picks which array to print.
 *
 * `COLORTERM` is the only signal that is actually load-bearing here: a terminal
 * that does not advertise truecolour may still be a 256-colour one, and printing
 * 24-bit sequences to it produces visible garbage rather than an approximation.
 */
function colorDepth(): 'truecolor' | '256' | 'none' {
  if (process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb') {
    return 'none';
  }

  const colorterm = process.env.COLORTERM ?? '';

  if (colorterm === 'truecolor' || colorterm === '24bit') {
    return 'truecolor';
  }

  // No TERM at all means nothing has told us what the terminal understands.
  return process.env.TERM ? '256' : 'none';
}

/**
 * The logo, once, before the run loop starts.
 *
 * Skipped entirely when stdout is not a terminal. `ramonda run` is meant to run
 * under a supervisor, where stdout is a pipe into a journal — and a screenful of
 * quadrant-block escape sequences at the top of every restart is noise in a log
 * that already opens with the `ramonda start:` line.
 */
export function printBanner(opts: { enabled: boolean }): void {
  if (!opts.enabled || !process.stdout.isTTY) {
    return;
  }

  const depth = colorDepth();
  // `||`, not `??`: a pty that was never given a window size reports 0 columns
  // rather than undefined — `script`, CI runners, a container started without a
  // sized TTY — and reading that as "too narrow" drops the art on every one of
  // them. An unknown width is assumed to be the usual 80.
  const columns = process.stdout.columns || 80;

  // Art that does not fit is worse than no art: the terminal wraps every row at
  // its own width and the flower arrives as confetti.
  if (depth === 'none' || columns < LOGO_WIDTH) {
    out(`ramonda v${VERSION}`);
    out('');

    return;
  }

  const rows = depth === 'truecolor' ? LOGO_TRUECOLOR : LOGO_256;

  out('');

  for (const row of rows) {
    out(row);
  }

  out(`${' '.repeat(WORDMARK_COLUMN)}${DIM}v${VERSION}${RESET}`);
  out('');
}
