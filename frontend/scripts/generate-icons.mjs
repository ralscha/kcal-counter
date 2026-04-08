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
const SOURCE_IMAGE_CANDIDATES = [
  'source_icon.png',
  'Image_tfo5fttfo5fttfo5.png',
  'public/icons/icon-512x512.png',
];

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

async function createTrimmedBaseBuffer(sourceImage) {
  // First, extract raw pixels from the source image to perform background removal
  return sharp(sourceImage)
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

      // Reconstruct the image with the transparent background and then TRIM it.
      // Trimming removes all the excess transparency, leaving only the tight bounds of the logo.
      return sharp(Buffer.from(rgba), {
        raw: {
          width,
          height,
          channels: 4,
        },
      })
        .png()
        .trim()
        .toBuffer();
    });
}

async function buildSquareImage(baseBuffer, size, marginRatio = 0.05) {
  // We use a small symmetric padding (e.g. 5%) so it's not totally flush against the bounds.
  // This helps it look proportionate in taskbars/home screens without being tiny.
  const padding = Math.round(size * marginRatio);
  const innerSize = size - padding * 2;

  // Handle case where size is very small, padding might be 0
  return sharp(baseBuffer)
    .resize(innerSize > 0 ? innerSize : size, innerSize > 0 ? innerSize : size, {
      fit: 'contain',
      position: 'center',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .extend({
      top: padding,
      bottom: padding,
      left: padding,
      right: padding,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
}

async function main() {
  if (!existsSync(ICONS_DIR)) {
    mkdirSync(ICONS_DIR, { recursive: true });
  }

  const sourceImage = resolveSourceImage();
  console.log(`Using source image: ${sourceImage}`);

  // Extract the cleanly cropped, transparent icon base
  const trimmedBaseBuffer = await createTrimmedBaseBuffer(sourceImage);

  // --- PWA PNG icons --------------------------------------------------------
  for (const size of PWA_SIZES) {
    const outPath = join(ICONS_DIR, `icon-${size}x${size}.png`);
    // Pass 8% margin for PWA / maskable so no edges touch
    await writeFileSync(outPath, await buildSquareImage(trimmedBaseBuffer, size, 0.08));
    console.log(`  ✓ icons/icon-${size}x${size}.png`);
  }

  // --- Apple Touch Icon (iOS home screen) -----------------------------------
  const atPath = join(ICONS_DIR, 'apple-touch-icon.png');
  writeFileSync(atPath, await buildSquareImage(trimmedBaseBuffer, 180, 0.08));
  console.log('  ✓ icons/apple-touch-icon.png');

  // --- In-app brand mark ----------------------------------------------------
  writeFileSync(
    join(PUBLIC_DIR, 'brand-mark.png'),
    await buildSquareImage(trimmedBaseBuffer, 96, 0.0),
  );
  console.log('  ✓ brand-mark.png');

  // --- Standard favicon PNGs ------------------------------------------------
  writeFileSync(
    join(PUBLIC_DIR, 'favicon-32x32.png'),
    await buildSquareImage(trimmedBaseBuffer, 32, 0.0),
  );
  console.log('  ✓ favicon-32x32.png');

  writeFileSync(
    join(PUBLIC_DIR, 'favicon-16x16.png'),
    await buildSquareImage(trimmedBaseBuffer, 16, 0.0),
  );
  console.log('  ✓ favicon-16x16.png');

  // --- favicon.ico (16 + 32 px embedded PNG) --------------------------------
  const [png16, png32] = await Promise.all([
    buildSquareImage(trimmedBaseBuffer, 16, 0.0),
    buildSquareImage(trimmedBaseBuffer, 32, 0.0),
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
