const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

/**
 * Whether to dress a line in colour at all.
 *
 * Per-stream, because the two are redirected independently — `ramonda run
 * 2>errors.log` leaves stdout a terminal and stderr a file, and escape
 * sequences in the file are noise nothing asked for. `NO_COLOR` and
 * `TERM=dumb` are honoured the way `src/banner/banner.ts` honours them, so one
 * environment turns the whole of ramonda's output plain.
 */
function colorEnabled(stream: NodeJS.WriteStream): boolean {
  if (process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb') {
    return false;
  }

  return stream.isTTY;
}

function paint(stream: NodeJS.WriteStream, color: string, line: string): string {
  return colorEnabled(stream) ? `${color}${line}${RESET}` : line;
}

/**
 * One line to stdout. The interactive commands report to the terminal directly
 * rather than through the winston loggers in `src/utils/logger.ts` — they write
 * no log file, and what they print is the whole of what they have to say.
 */
export function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * A step that went the way it was meant to, in green with a check.
 *
 * The setup commands print a wall of plain text — what was written, what it
 * means, what to change — and the one thing someone scanning it is looking for
 * is whether the thing worked. Colour answers that without being read.
 */
export function success(line: string): void {
  out(paint(process.stdout, GREEN, `✓ ${line}`));
}

/** A step that did not, in red. Marked `!` rather than `✗`: it is not always fatal. */
export function failure(line: string): void {
  out(paint(process.stdout, RED, `! ${line}`));
}

/**
 * Yellow, for a line the reader has to **act on** rather than merely read.
 *
 * Returns rather than prints, because the lines that want it are notes inside a
 * `nextStep` block and have to keep their place in it. Nothing else in a setup
 * command's output is an instruction with a consequence for skipping it, so this
 * stays scarce enough to mean something.
 */
export function warning(line: string): string {
  return paint(process.stdout, YELLOW, line);
}

/**
 * An error, on stderr, in red — where every command ends up when it throws.
 *
 * Painted here rather than at the call site so the stream and the colour are
 * decided together: stderr is the one this writes to, and stderr is the one
 * `colorEnabled` is asked about.
 */
export function errorOut(line: string): void {
  process.stderr.write(`${paint(process.stderr, RED, line)}\n`);
}

/**
 * The "what to run next" every command signs off with.
 *
 * Ramonda is four commands in a fixed order, and nothing on the machine says
 * where in that order you are. Each command therefore ends by naming the next
 * one in full, so the sequence is carried by the output rather than by having
 * read the README recently.
 */
export function nextStep(opts: { command: string; notes?: string[] }): void {
  out('');
  out(`Next: ${paint(process.stdout, BOLD, opts.command)}`);

  for (const note of opts.notes ?? []) {
    out(`  ${note}`);
  }
}
