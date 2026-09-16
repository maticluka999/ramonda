/**
 * Every step of an interactive command is a question, so one started without a
 * terminal exits non-zero here rather than hanging on input that will never
 * come. Checked before the first question so the refusal costs no answers.
 */
export function assertInteractive(command: string): void {
  if (!process.stdin.isTTY) {
    throw new Error(`"ramonda ${command}" is interactive and needs a terminal.`);
  }
}
