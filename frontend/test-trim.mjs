import sharp from 'sharp';
import fs from 'fs';
const src = fs.existsSync('c:/w/ws/github/kcal-counter/frontend/source_icon.png')
  ? 'c:/w/ws/github/kcal-counter/frontend/source_icon.png'
  : 'c:/w/ws/github/kcal-counter/frontend/Image_tfo5fttfo5fttfo5.png';
async function test() {
  const m1 = await sharp(src).metadata();
  console.log('Original:', m1.width, m1.height);
  const trimmed = await sharp(src).trim().toBuffer();
  const m2 = await sharp(trimmed).metadata();
  console.log('Trimmed:', m2.width, m2.height);
}
test();
