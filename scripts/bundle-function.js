#!/usr/bin/env node
// Flattens one edge function into a single file, for pasting into the Supabase
// dashboard's function editor.
//
// The functions here import from ../_shared/, which is right for the CLI and
// impossible for the dashboard editor: it deploys the files of one folder and
// cannot follow a relative path out of it. Somebody working without a terminal
// would otherwise have to inline the shared mailer by hand, and then keep that
// copy in step with the original — which is the same as not keeping it.
//
//   node scripts/bundle-function.js support-notify
//
// The result is written to dist-functions/<name>.ts and is a build artifact:
// generate it, paste it, delete it. The repo stays the source of truth.
//
// npm: and https:// imports are deliberately left alone. Deno resolves those at
// deploy time and bundling them in would be both enormous and wrong.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const name = process.argv[2];
if (!name) {
  console.error('Usage: node scripts/bundle-function.js <function-name>\n' +
                'e.g.   node scripts/bundle-function.js support-notify');
  process.exit(1);
}

const root = path.join(__dirname, '..');
const entry = path.join(root, 'supabase', 'functions', name, 'index.ts');
if (!fs.existsSync(entry)) {
  console.error(`No such function: ${path.relative(root, entry)}`);
  process.exit(1);
}

const outDir = path.join(root, 'dist-functions');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${name}.ts`);

const banner = [
  `// Verceil Bank — ${name}, single file for the Supabase dashboard editor.`,
  `// Generated from supabase/functions/${name}/index.ts with its _shared imports`,
  '// inlined, because the dashboard editor cannot follow a relative import out of',
  "// the function's own folder. The source of truth is the repo; regenerate rather",
  '// than editing this by hand.',
].join('\n');

execFileSync('npx', [
  '--yes', 'esbuild@0.24.0', entry,
  '--bundle', '--format=esm', '--target=es2022', '--platform=neutral',
  '--external:npm:*', '--external:https://*',
  `--banner:js=${banner}`,
  `--outfile=${outFile}`,
], { stdio: ['ignore', 'ignore', 'inherit'] });

console.log(`Wrote ${path.relative(root, outFile)} — paste it into the dashboard's editor for ${name}.`);
