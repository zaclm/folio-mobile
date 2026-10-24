// Generates the Android launcher icons and splash logo from build/icon.svg's artwork.
// Run: node mobile/scripts/make-icons.mjs   (needs the `sharp` devDependency)
import sharp from 'sharp';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const res = join(root, 'android', 'app', 'src', 'main', 'res');
const iconSvg = readFileSync(join(root, 'build', 'icon.svg'));

// The page glyph from build/icon.svg, centred on a transparent 512 canvas (= 108dp adaptive layer).
// The visible part of an adaptive icon is the middle 72dp, so the glyph stays well inside it.
const glyph = `
  <g transform="translate(256 256) scale(0.82) translate(-252 -260)">
    <path d="M168 120h128l72 72v176a32 32 0 0 1-32 32H168a32 32 0 0 1-32-32V152a32 32 0 0 1 32-32Z" fill="#FFFFFF"/>
    <path d="M296 120v48a24 24 0 0 0 24 24h48" fill="#F3DED4"/>
    <path d="M184 252h144M184 300h144M184 348h88" stroke="#C4633F" stroke-width="22" stroke-linecap="round"/>
  </g>`;
const foregroundSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${glyph}</svg>`);
const roundSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#D2714C"/><stop offset="1" stop-color="#B9573A"/></linearGradient></defs>
  <circle cx="256" cy="256" r="240" fill="url(#g)"/>
  <g transform="translate(256 256) scale(1.12) translate(-256 -256)">${glyph}</g></svg>`);

const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

async function png(svg, size, out) {
  mkdirSync(dirname(out), { recursive: true });
  await sharp(svg, { density: 384 }).resize(size, size).png({ compressionLevel: 9 }).toFile(out);
}

for (const [d, k] of Object.entries(densities)) {
  const dir = join(res, `mipmap-${d}`);
  await png(iconSvg, Math.round(48 * k), join(dir, 'ic_launcher.png'));
  await png(roundSvg, Math.round(48 * k), join(dir, 'ic_launcher_round.png'));
  await png(foregroundSvg, Math.round(108 * k), join(dir, 'ic_launcher_foreground.png'));
}

// Small logo for the launch screen (Android 11 and older draw it from drawable/splash_screen.xml)
await png(iconSvg, 288, join(res, 'drawable-nodpi', 'splash_logo.png'));

writeFileSync(join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml'), `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`);
writeFileSync(join(res, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'), readFileSync(join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml')));
console.log('icons written to', res);
