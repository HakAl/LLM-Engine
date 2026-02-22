import { readFileSync } from 'node:fs';

/**
 * Parse a .env file and return its key-value pairs.
 *
 * This is the ONLY source of API keys — system environment
 * variables are never consulted.
 *
 * Returns an empty record if the file doesn't exist.
 */
/** Strip matching surrounding quotes (single or double) from a value. */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function parseDotEnv(path = '.env'): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    const content = readFileSync(path, 'utf8').replace(/\r/g, '');
    for (const line of content.split('\n')) {
      const idx = line.indexOf('=');
      if (idx < 1 || line.startsWith('#')) continue;
      const key = line.slice(0, idx).trim();
      const raw = line.slice(idx + 1).trim();
      const val = stripQuotes(raw);
      if (val) {
        result[key] = val;
      }
    }
  } catch {
    // .env file doesn't exist or isn't readable
  }
  return result;
}
