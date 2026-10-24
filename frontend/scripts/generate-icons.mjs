/** Generate the app's icon assets with `pnpm run icons` from frontend/. */
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(SCRIPT_DIR, '..', 'public');
const ICONS_DIR = join(PUBLIC_DIR, 'icons');
// Always resize the source, never a generated icon: repeated runs must not degrade it.
const SOURCE_IMAGE = join(SCRIPT_DIR, 'assets', 'app-icon.png');
const PWA_SIZES = [48, 64, 72, 96, 128, 144, 152, 192, 256, 384, 512];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
const MASKABLE_BACKGROUND = '#246e78';

async function buildSquareImage(base, size, marginRatio = 0) {
  const padding = Math.round(size * marginRatio);
  const innerSize = size - padding * 2;
  return sharp(base)
    .resize(innerSize, innerSize, { fit: 'contain', background: TRANSPARENT })
    .extend({
      top: padding,
      bottom: padding,
      left: padding,
      right: padding,
      background: TRANSPARENT,
    })
    .png()
    .toBuffer();
}

async function buildMaskableImage(base, size) {
  // Only mobile maskable icons need padding and an opaque, edge-to-edge background.
  // The pear and tape stay inside the central safe circle (40% radius).
  return sharp(await buildSquareImage(base, size, 0.08))
    .flatten({ background: MASKABLE_BACKGROUND })
    .png()
    .toBuffer();
}

async function main() {
  await mkdir(ICONS_DIR, { recursive: true });
  const base = await sharp(SOURCE_IMAGE).trim().png().toBuffer();

  // Desktop icons fill the canvas; sharing maskable padding makes them look tiny.
  for (const size of PWA_SIZES) {
    await writeFile(
      join(ICONS_DIR, `icon-${size}x${size}.png`),
      await buildSquareImage(base, size),
    );
  }
  for (const size of [192, 512]) {
    await writeFile(
      join(ICONS_DIR, `icon-maskable-${size}x${size}.png`),
      await buildMaskableImage(base, size),
    );
  }
  await writeFile(join(ICONS_DIR, 'apple-touch-icon.png'), await buildMaskableImage(base, 180));
  await writeFile(join(PUBLIC_DIR, 'brand-mark.png'), await buildSquareImage(base, 96));
  for (const size of [16, 32]) {
    await writeFile(
      join(PUBLIC_DIR, `favicon-${size}x${size}.png`),
      await buildSquareImage(base, size),
    );
  }

  // Include native Windows desktop sizes as well as small browser favicons.
  const icoFrames = await Promise.all(ICO_SIZES.map((size) => buildSquareImage(base, size)));
  await writeFile(join(PUBLIC_DIR, 'favicon.ico'), await pngToIco(icoFrames));
  console.log('Generated desktop, maskable, Apple touch, and Windows icons.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
