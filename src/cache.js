import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const CACHE_FILE = path.join('cache', 'progress.json');

export const loadCache = async () => {
  if (!existsSync(CACHE_FILE)) return {};
  const raw = await readFile(CACHE_FILE, 'utf8').catch(() => '{}');
  return JSON.parse(raw);
};

export const saveToCache = async (url, data) => {
  await mkdir('cache', { recursive: true });
  const cache = await loadCache();
  cache[url] = data;
  await writeFile(CACHE_FILE, JSON.stringify(cache));
};

export const clearCache = async () => {
  await mkdir('cache', { recursive: true });
  await writeFile(CACHE_FILE, '{}');
};

export const cacheSize = async () => {
  const cache = await loadCache();
  return Object.keys(cache).length;
};
