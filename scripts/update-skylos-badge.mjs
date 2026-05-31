import { readFile, writeFile } from 'node:fs/promises';

const inputPath = process.argv[2];

if (!inputPath) {
  console.error('Usage: node scripts/update-skylos-badge.mjs <skylos-results.json>');
  process.exit(1);
}

const results = JSON.parse(await readFile(inputPath, 'utf8'));
const overall = results.grade?.overall;

if (!overall || typeof overall.score !== 'number' || typeof overall.letter !== 'string') {
  console.error('Skylos results are missing grade.overall.score or grade.overall.letter.');
  process.exit(1);
}

const score = Math.round(overall.score);
const color = score >= 90 ? 'brightgreen' : score >= 80 ? 'green' : score >= 70 ? 'yellow' : score >= 60 ? 'orange' : 'red';
const badge = {
  schemaVersion: 1,
  label: 'Skylos',
  message: `${overall.letter} (${score})`,
  color,
};

await writeFile(new URL('../.github/badges/skylos.json', import.meta.url), `${JSON.stringify(badge, null, 2)}\n`);
