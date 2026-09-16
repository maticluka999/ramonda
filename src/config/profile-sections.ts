import { parse as parseDotenv } from 'dotenv';

/** The default profile marker: the token that sits ahead of the name in a section header. */
export const DEFAULT_PROFILE_MARKER = 'default';

/**
 * A profile section header. Every profile is named, and the name is the last
 * token in the header; a `default` ahead of it is the default profile marker,
 * which makes this the profile commands use when `--profile` is omitted —
 * `[work]` or `[default work]`. So the marker is never implied: a bare
 * `[default]` is one token and therefore a profile *named* `default`, no more
 * the default one than `[work]` is, and `[default default]` is how that profile
 * carries the marker. Nothing else nominates a default, which is what keeps
 * every state of the file writable — a name can be demoted, because its header
 * is not also its status.
 */
const SECTION_HEADER = /^\s*\[\s*(?:(default)\s+)?([^\s\]]+)\s*\]\s*$/;

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

const COMMENT_OR_BLANK = /^\s*(?:#.*)?$/;

export type ProfileSection = {
  /** The name the section is keyed by. */
  name: string;
  /** True when the header carries the default profile marker. */
  isDefault: boolean;
  values: Map<string, string>;
  /** Line index of the header, so a rewrite can find the body again. */
  headerLine: number;
};

export type ParsedConfig = {
  /** In file order. */
  sections: ProfileSection[];
};

/**
 * The same parser `loadConfig` uses, so setup-profile can never disagree with
 * the loader about what a file already says — a hand-rolled one silently kept
 * `# comments` as part of the value and then wrote them back quoted.
 */
function parseValues(lines: string[]): Map<string, string> {
  return new Map(Object.entries(parseDotenv(lines.join('\n'))));
}

/**
 * Above the first header there is no profile for a key to belong to, so a file
 * that opens with one is rejected rather than read past. Every value ramonda
 * stores is per-profile; a key sitting outside a section could only ever be a
 * value nothing resolves, and reading the file as if it were fine is how a token
 * ends up present, unread, and blamed on the wrong thing. Comments and blank
 * lines are the exception — they carry no value to lose.
 */
function assertPreamble(line: string, index: number, source: string | undefined): void {
  if (COMMENT_OR_BLANK.test(line)) {
    return;
  }

  const key = KEY_LINE.exec(line)?.[1];
  const where = source === undefined ? `line ${index + 1}` : `${source}:${index + 1}`;

  // Named, never echoed: the offending line is as likely as not to be a token.
  throw new Error(
    `${where}: ${key ? `"${key}"` : 'this line'} sits above the first profile header. ` +
      `Every key belongs under a "[<profile>]" — or "[${DEFAULT_PROFILE_MARKER} <profile>]" — header, ` +
      `and only comments and blank lines may come before one.`
  );
}

export function parseConfig(raw: string, source?: string): ParsedConfig {
  const lines = raw === '' ? [] : raw.split('\n');
  const sections: ProfileSection[] = [];
  let header: { name: string; isDefault: boolean; line: number } | undefined;
  let body: string[] = [];

  const flush = (): void => {
    if (header) {
      sections.push({
        name: header.name,
        isDefault: header.isDefault,
        headerLine: header.line,
        values: parseValues(body),
      });
    }
  };

  for (const [index, line] of lines.entries()) {
    const match = SECTION_HEADER.exec(line);

    if (!match) {
      if (header) {
        body.push(line);
      } else {
        assertPreamble(line, index, source);
      }

      continue;
    }

    // The block just collected belongs to the *previous* header.
    flush();
    header = { name: match[2], isDefault: match[1] !== undefined, line: index };
    body = [];
  }

  flush();

  return { sections };
}

export function formatHeader(name: string, isDefault: boolean): string {
  return isDefault ? `[${DEFAULT_PROFILE_MARKER} ${name}]` : `[${name}]`;
}

/** Anything a section header cannot hold, since the file is the only record of the name. */
export function assertValidProfileName(name: string): void {
  if (name === '' || /[\s\][]/.test(name)) {
    throw new Error(`"${name}" is not a usable profile name — pick one with no spaces or brackets.`);
  }
}

/**
 * dotenv strips one layer of surrounding quotes and unescapes nothing, so a
 * value only survives inside a form it decodes literally. Backticks are that
 * form: unlike double quotes they expand no \n or \r, so they carry every
 * character but the backtick itself. The other two forms are left for the
 * values a backtick cannot wrap.
 */
function quoteValue(value: string): string {
  // These files are rewritten a line at a time, so a value spanning two of them
  // loses its second line, or has it read back as a key or a header in its own
  // right. dotenv also rewrites a lone \r to \n before parsing, so neither
  // character round trips under any quoting.
  if (/[\n\r]/.test(value)) {
    throw new Error('a value containing a line break cannot be stored in a ramonda config file');
  }

  if (/^[A-Za-z0-9_.:@/=+-]*$/.test(value)) {
    return value;
  }

  if (!value.includes('`')) {
    return `\`${value}\``;
  }

  if (!value.includes("'")) {
    return `'${value}'`;
  }

  // Past here the value holds both a ` and a ', so the double-quoted form is the
  // only one left — and dotenv expands \n and \r inside it, so a value carrying
  // one of those escapes would come back a line break rather than as it went in.
  if (!value.includes('"') && !/\\[nr]/.test(value)) {
    return `"${value}"`;
  }

  throw new Error(
    value.includes('"')
      ? 'a value containing `, \' and " together cannot be stored in a ramonda config file'
      : "a value containing ` and ' alongside a \\n or \\r escape cannot be stored in a ramonda config file"
  );
}

function trimTrailingBlanks(lines: string[]): string[] {
  const kept = [...lines];

  while (kept.length > 0 && kept[kept.length - 1].trim() === '') {
    kept.pop();
  }

  return kept;
}

/**
 * Rewrites in place so hand-written comments and any keys ramonda does not own
 * survive. A null value means "remove this key" — used when an answer falls back
 * to the built-in default and the file no longer needs to say anything.
 */
function upsertLines(lines: string[], updates: Map<string, string | null>): string[] {
  const written = new Set<string>();
  const kept: string[] = [];

  for (const line of lines) {
    const key = KEY_LINE.exec(line)?.[1];

    if (!key || !updates.has(key)) {
      kept.push(line);
      continue;
    }

    const value = updates.get(key) ?? null;
    written.add(key);

    if (value !== null) {
      kept.push(`${key}=${quoteValue(value)}`);
    }
  }

  const body = trimTrailingBlanks(kept);

  for (const [key, value] of updates) {
    if (value !== null && !written.has(key)) {
      body.push(`${key}=${quoteValue(value)}`);
    }
  }

  return body;
}

/** One blank line between blocks, one trailing newline, nothing else added. */
function render(blocks: string[][]): string {
  return `${blocks.map((block) => block.join('\n')).join('\n\n')}\n`;
}

/**
 * Writes one profile's keys into `raw`, leaving every other section — and every
 * comment — as it found them. Being the default is a property of the file rather
 * than of a section, so marking this profile clears the default profile marker
 * everywhere else; passing `false` never promotes some other section in its place.
 */
export function upsertProfile(
  raw: string,
  opts: { profile: string; isDefault: boolean; updates: Map<string, string | null> }
): string {
  const parsed = parseConfig(raw);
  const lines = raw === '' ? [] : raw.split('\n');

  const bodyEnd = (index: number): number =>
    index + 1 < parsed.sections.length ? parsed.sections[index + 1].headerLine : lines.length;
  // Whatever precedes the first header is comments — the parser admits nothing
  // else there — so it stays where its author put it rather than being drawn
  // into the section this writes.
  const preambleEnd = parsed.sections.length > 0 ? parsed.sections[0].headerLine : lines.length;
  const preamble = trimTrailingBlanks(lines.slice(0, preambleEnd));
  const blocks: string[][] = preamble.length > 0 ? [preamble] : [];
  let found = false;

  for (const [index, section] of parsed.sections.entries()) {
    const isTarget = section.name === opts.profile;
    found ||= isTarget;
    const body = lines.slice(section.headerLine + 1, bodyEnd(index));
    const isDefault = isTarget ? opts.isDefault : section.isDefault && !opts.isDefault;

    blocks.push([
      formatHeader(section.name, isDefault),
      ...(isTarget ? upsertLines(body, opts.updates) : trimTrailingBlanks(body)),
    ]);
  }

  if (!found) {
    blocks.push([formatHeader(opts.profile, opts.isDefault), ...upsertLines([], opts.updates)]);
  }

  return render(blocks);
}
