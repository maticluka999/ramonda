import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from this module's own compiled file, so it reads the same
// package.json whether ramonda runs from `dist` or from a linked checkout.
// `..`, `..` because this module sits in `utils/`, one level under the build root.
const PACKAGE_JSON = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');

const PACKAGE = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
  version: string;
  engines: { node: string };
};

export const VERSION: string = PACKAGE.version;

/**
 * The Node floor, read off the `engines` range `package.json` already declares
 * rather than repeated here, so the two cannot drift.
 *
 * npm enforces that range at install time and nowhere else, which does nothing
 * for a clone that was linked once and is now being run under whichever node is
 * on PATH today — hence the check in the CLI that reads this.
 */
export const MIN_NODE: string = PACKAGE.engines.node.replace(/^[^\d]*/, '');
