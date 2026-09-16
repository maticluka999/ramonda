import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import winston from 'winston';

const LOG_ROOT = join(homedir(), '.local', 'state', 'ramonda', 'logs');

const MIRROR_TO_STDOUT = process.env.RAMONDA_LOG_STDOUT === '1';

export const TERMINAL = { terminal: true } as const;

/** Winston hands lines to a write stream, so a hard exit can drop queued ones. */
const openLoggers = new Set<winston.Logger>();

export function runLogPath(runId: string): string {
  return join(LOG_ROOT, `${runId}_main.log`);
}

export function taskLogPath(args: { runId: string; issue: number; slug: string }): string {
  return join(LOG_ROOT, args.runId, `${args.issue}-${args.slug}.log`);
}

function fileTransport(path: string): winston.transport {
  // Winston opens the file lazily but never creates the directory for it.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  return new winston.transports.File({
    filename: path,
    options: { flags: 'a', mode: 0o600 },
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.printf((info) => `${info.timestamp as string} ${info.message as string}`)
    ),
    eol: '\n',
  });
}

function consoleTransport(): winston.transport {
  const terminalOnly = winston.format((info) => (MIRROR_TO_STDOUT || info.terminal === true ? info : false));

  return new winston.transports.Console({
    format: winston.format.combine(
      terminalOnly(),
      winston.format.printf((info) => info.message as string)
    ),
  });
}

function build(transports: winston.transport[]): winston.Logger {
  const logger = winston.createLogger({ level: 'silly', transports });

  // Logging is best-effort: an unwritable log file must not take down a run, and
  // an unhandled 'error' on the logger stream would do exactly that. Winston
  // re-emits transport errors here, and an fs error names the file it failed on.
  logger.on('error', (err: Error) => {
    process.stderr.write(`ramonda: log write failed: ${err.message}\n`);
  });
  // Every logger is tracked, so `flushLogs()` takes no arguments.
  openLoggers.add(logger);

  return logger;
}

export function createLogger(path: string): winston.Logger {
  return build([fileTransport(path), consoleTransport()]);
}

/**
 * A logger for a process whose stdout belongs to something other than an
 * operator watching a run.
 *
 * The Stop hook's belongs to Claude Code: the one thing it may put there is the
 * `{"decision":"block"}` document that re-prompts the model, and a second line
 * on that stream is a hook whose verdict cannot be read. So it takes the file
 * transport alone — no `TERMINAL` line and, more to the point, no
 * `RAMONDA_LOG_STDOUT` can reach stdout through it. The variable is inherited by
 * the session and by every hook under it, so a run started with it set would
 * otherwise mirror the hook's own progress lines into Claude Code's channel.
 */
export function createFileLogger(path: string): winston.Logger {
  return build([fileTransport(path)]);
}

/**
 * Drains a logger and lets go of it. An unwritable file never finishes, so the
 * wait is capped; `ref: false` keeps the cap itself from holding the process open.
 */
async function endLogger(logger: winston.Logger, timeoutMs: number): Promise<void> {
  const finished = new Promise<void>((resolve) => logger.once('finish', resolve));
  logger.end();

  await Promise.race([finished, sleep(timeoutMs, undefined, { ref: false })]);
}

/**
 * Winston hands lines to a write stream and returns; `process.exit()` right
 * after a log call would discard whatever is still queued. Call this before any
 * deliberate exit. Natural exits need no flush — pending writes hold the loop
 * open on their own.
 */
export async function flushLogs(timeoutMs = 2000): Promise<void> {
  const pending = [...openLoggers];
  openLoggers.clear();

  await Promise.all(pending.map((logger) => endLogger(logger, timeoutMs)));
}

/**
 * Closes one logger whose work is done, rather than waiting for process exit.
 *
 * A file transport holds its write stream open for the life of the logger, and
 * the loop builds one logger per task — so a run that never ends would hold an
 * open descriptor for every task it has ever picked up, and eventually fail on
 * EMFILE somewhere unrelated. The run logger stays open for the whole process
 * and is left to `flushLogs`.
 */
export async function closeLogger(logger: winston.Logger, timeoutMs = 2000): Promise<void> {
  if (!openLoggers.delete(logger)) {
    return;
  }

  await endLogger(logger, timeoutMs);
}
