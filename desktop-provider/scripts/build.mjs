import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir } from 'node:fs/promises';
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--core-dir') throw new Error('Usage: node scripts/build.mjs --core-dir /absolute/path/to/core');
const coreDir = resolve(args[1]);
const require = createRequire(resolve(coreDir, 'package.json'));
const { build } = require('esbuild');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const notice = await readFile(resolve(root, 'voice-grok.LICENSE'), 'utf8');
await mkdir(resolve(root, 'desktop'), { recursive: true });
await build({
  absWorkingDir: root, entryPoints: ['src/index.ts'], outfile: 'desktop/plugin.js',
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  legalComments: 'eof', banner: { js: '/*!\n' + notice + '\n*/' },
  write: true
});
console.log('Built desktop/plugin.js (native provider API v1, no runtime imports)');
