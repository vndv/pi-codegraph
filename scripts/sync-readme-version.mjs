import { readFile, writeFile } from 'node:fs/promises';

const checkOnly = process.argv.includes('--check');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const readmeUrl = new URL('../README.md', import.meta.url);
const readme = await readFile(readmeUrl, 'utf8');
const packageName = packageJson.name;
const version = packageJson.version;
const installPattern = new RegExp(`npm:${packageName.replaceAll('/', '\\/')}@\\d+\\.\\d+\\.\\d+`, 'g');
const expected = `npm:${packageName}@${version}`;
const updated = readme.replace(installPattern, expected);

if (updated === readme) {
  console.log(`README package version already ${version}.`);
  process.exit(0);
}

if (checkOnly) {
  console.error(`README package version is stale. Run npm run sync:readme-version.`);
  process.exit(1);
}

await writeFile(readmeUrl, updated);
console.log(`Updated README package references to ${version}.`);
