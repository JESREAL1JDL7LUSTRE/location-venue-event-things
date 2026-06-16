import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const TEMPLATE = path.join('src', 'map-template.html');
const DATA     = path.join('output', 'venues.json');
const OUT      = path.join('output', 'map.html');

const [template, venues] = await Promise.all([
  readFile(TEMPLATE, 'utf8'),
  readFile(DATA, 'utf8').then(JSON.parse),
]);

await mkdir('output', { recursive: true });
await writeFile(OUT, template.replace('VENUES_DATA_PLACEHOLDER', JSON.stringify(venues)));
console.log(`Map built → ${OUT}  (${venues.length} venues)`);
