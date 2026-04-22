import { readFile } from 'node:fs/promises';

export function parseEnvFile(raw) {
  const entries = new Map();

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    value = value.replace(/(?:\\r|\\n|\r|\n)+$/g, '').trim();
    entries.set(key, value);
  }

  return entries;
}

export async function readEnvFile(filePath) {
  try {
    return parseEnvFile(await readFile(filePath, 'utf8'));
  } catch {
    return new Map();
  }
}

export function envMapToObject(entries) {
  return Object.fromEntries(entries.entries());
}
