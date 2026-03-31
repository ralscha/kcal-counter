/**
 * Generates all favicons and PWA icons for the kcal-counter app from a
 * provided PNG brand image in the repository root.
 *
 * Usage: bun run scripts/generate-icons.mjs
 */

import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const ICONS_DIR = join(PUBLIC_DIR, 'icons');
const SOURCE_IMAGE_CANDIDATES = ['source_icon.png', 'Image_tfo5fttfo5fttfo5.png'];

// PWA icon sizes required by the manifest
const PWA_SIZES = [72, 96, 128, 144, 152, 192, 384, 512];

function resolveSourceImage() {
  for (const fileName of SOURCE_IMAGE_CANDIDATES) {
    const filePath = join(__dirname, '..', fileName);
    if (existsSync(filePath)) {
      return filePath;
    }
  }

  throw new Error(
    `No PNG source image found. Expected one of: ${SOURCE_IMAGE_CANDIDATES.join(', ')}`,
  );
}

async function buildSquareImage(sourceImage, size) {
  return sharp(sourceImage)
    .resize(size, size, {
      fit: 'contain',
      position: 'center',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .then(({ data, info }) => {
      const rgba = new Uint8ClampedArray(data);
      const width = info.width;
      const height = info.height;
      const background = new Uint8Array(width * height);
      const queue = [];

      function isBackgroundPixel(index) {
        const red = rgba[index];
        const green = rgba[index + 1];
        const blue = rgba[index + 2];
        const alpha = rgba[index + 3];
        const max = Math.max(red, green, blue);
        const min = Math.min(red, green, blue);
        const brightness = (red + green + blue) / 3;

        return alpha > 0 && brightness >= 236 && max - min <= 28;
      }

      function enqueue(x, y) {
        if (x < 0 || x >= width || y < 0 || y >= height) {
          return;
        }

        const pixelIndex = y * width + x;
        if (background[pixelIndex]) {
          return;
        }

        const rgbaIndex = pixelIndex * 4;
        if (!isBackgroundPixel(rgbaIndex)) {
          return;
        }

        background[pixelIndex] = 1;
        queue.push(pixelIndex);
      }

      for (let x = 0; x < width; x += 1) {
        enqueue(x, 0);
        enqueue(x, height - 1);
      }

      for (let y = 0; y < height; y += 1) {
        enqueue(0, y);
        enqueue(width - 1, y);
      }

      while (queue.length > 0) {
        const pixelIndex = queue.shift();
        const x = pixelIndex % width;
        const y = Math.floor(pixelIndex / width);

        enqueue(x - 1, y);
        enqueue(x + 1, y);
        enqueue(x, y - 1);
        enqueue(x, y + 1);
      }

      for (let pixelIndex = 0; pixelIndex < background.length; pixelIndex += 1) {
        if (background[pixelIndex]) {
          rgba[pixelIndex * 4 + 3] = 0;
        }
      }

      return sharp(Buffer.from(rgba), {
        raw: {
          width,
          height,
          channels: 4,
        },
      })
        .png()
        .toBuffer();
    });
}

async function main() {
  if (!existsSync(ICONS_DIR)) {
    mkdirSync(ICONS_DIR, { recursive: true });
  }

  const sourceImage = resolveSourceImage();

  // --- PWA PNG icons --------------------------------------------------------
  for (const size of PWA_SIZES) {
    const outPath = join(ICONS_DIR, `icon-${size}x${size}.png`);
    await writeFileSync(outPath, await buildSquareImage(sourceImage, size));
    console.log(`  ✓ icons/icon-${size}x${size}.png`);
  }

  // --- Apple Touch Icon (iOS home screen) -----------------------------------
  const atPath = join(ICONS_DIR, 'apple-touch-icon.png');
  writeFileSync(atPath, await buildSquareImage(sourceImage, 180));
  console.log('  ✓ icons/apple-touch-icon.png');

  // --- In-app brand mark ----------------------------------------------------
  writeFileSync(join(PUBLIC_DIR, 'brand-mark.png'), await buildSquareImage(sourceImage, 96));
  console.log('  ✓ brand-mark.png');

  // --- Standard favicon PNGs ------------------------------------------------
  writeFileSync(join(PUBLIC_DIR, 'favicon-32x32.png'), await buildSquareImage(sourceImage, 32));
  console.log('  ✓ favicon-32x32.png');

  writeFileSync(join(PUBLIC_DIR, 'favicon-16x16.png'), await buildSquareImage(sourceImage, 16));
  console.log('  ✓ favicon-16x16.png');

  // --- favicon.ico (16 + 32 px embedded PNG) --------------------------------
  const [png16, png32] = await Promise.all([
    buildSquareImage(sourceImage, 16),
    buildSquareImage(sourceImage, 32),
  ]);
  const icoBuffer = await pngToIco([png16, png32]);
  writeFileSync(join(PUBLIC_DIR, 'favicon.ico'), icoBuffer);
  console.log('  ✓ favicon.ico');

  console.log('\nAll icons generated successfully.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
