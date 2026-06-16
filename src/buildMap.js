import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TEMPLATE = path.join('output', 'map.html');
const DATA     = path.join('output', 'venues.json');
const OUT      = path.join('output', 'map.html');

const venues = JSON.parse(await readFile(DATA, 'utf8'));
const template = await readFile(TEMPLATE, 'utf8');

const html = template.replace('VENUES_DATA_PLACEHOLDER', JSON.stringify(venues));
await writeFile(OUT, html);
console.log(`Map built: ${OUT} (${venues.length} venues)`);
