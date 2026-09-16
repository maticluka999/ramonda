import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_HOME = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');

export const CONFIG_DIR = join(CONFIG_HOME, 'ramonda');

export const CREDENTIALS_PATH = join(CONFIG_DIR, 'credentials');

export const SETTINGS_PATH = join(CONFIG_DIR, 'settings');
