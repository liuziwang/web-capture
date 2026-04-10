import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(process.cwd(), 'web-structure-archiver-plugin-v2.1.13.8-debuglog-finaltargeted');
const capture = readFileSync(resolve(root, 'capture.js'), 'utf8');
const background = readFileSync(resolve(root, 'background.js'), 'utf8');
const popup = readFileSync(resolve(root, 'popup.js'), 'utf8');

assert.match(capture, /function staticizeGenericCarousels/);
assert.match(capture, /highFidelityLimit/);
assert.match(capture, /shouldSnapshotForHighFidelity/);

assert.match(background, /function fetchWithRetry/);
assert.match(background, /function shortHash/);
assert.match(background, /isImageLikeContentType/);
assert.match(background, /isImageLikeResource/);
assert.ok(background.includes('includeScripts: imagesOnly ? false : options.includeScripts !== false'));
assert.ok(background.includes('includeMedia: imagesOnly ? true : options.includeMedia !== false'));
assert.ok(background.includes('if (item.output.localPath)'));

assert.match(popup, /imagesOnly/);
assert.match(popup, /syncToggleState/);

console.log('regression smoke checks passed');
