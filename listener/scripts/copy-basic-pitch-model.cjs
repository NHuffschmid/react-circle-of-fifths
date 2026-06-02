// Copies the BasicPitch TF.js model from node_modules into public/ so that Vite
// can serve it in dev mode and bundle it into dist/ for production builds.
// Runs automatically as a postinstall hook (see package.json).

const fs   = require('fs');
const path = require('path');

const src  = path.join(__dirname, '..', 'node_modules', '@spotify', 'basic-pitch', 'model');
const dest = path.join(__dirname, '..', 'public', 'basic-pitch-model');

if (!fs.existsSync(src)) {
    console.warn('[postinstall] @spotify/basic-pitch model not found — skipping copy.');
    process.exit(0);
}

fs.mkdirSync(dest, { recursive: true });

for (const file of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, file), path.join(dest, file));
}

console.log(`[postinstall] BasicPitch model copied to public/basic-pitch-model/`);
