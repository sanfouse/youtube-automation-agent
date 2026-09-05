// Lists prompts requested by IMAGE_PROVIDER=manual (utils/ai-video-generator.js
// generateManualImage) that are still missing their image file, and the exact
// path each one needs to be saved to. Run with: npm run manual-images:pending

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const inboxDir = process.env.MANUAL_IMAGE_INBOX || path.join(__dirname, '..', 'data', 'manual-images');
const logPath = path.join(inboxDir, 'prompts.jsonl');
const extensions = ['.png', '.jpg', '.jpeg', '.webp'];

if (!fs.existsSync(logPath)) {
  console.log(`No prompts logged yet at ${logPath} — run a production with IMAGE_PROVIDER=manual first.`);
  process.exit(0);
}

const seen = new Map();
for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const entry = JSON.parse(line);
  seen.set(entry.hash, entry);
}

let pending = 0;
for (const { hash, prompt, requestedAt } of seen.values()) {
  const found = extensions.map((ext) => path.join(inboxDir, `${hash}${ext}`)).find(fs.existsSync);
  if (found) continue;
  pending += 1;
  console.log(`\n[pending since ${requestedAt}]`);
  console.log(`  save as: ${path.join(inboxDir, hash + '.png')}  (or .jpg/.jpeg/.webp)`);
  console.log(`  prompt:  ${prompt}`);
}

console.log(pending ? `\n${pending} image(s) still needed.` : '\nNothing pending — every logged prompt has an image.');
