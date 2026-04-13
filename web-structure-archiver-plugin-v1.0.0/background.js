const CAPTURE_FILE = 'capture.js';
const pendingCaptures = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'ARCHIVE_PAGE_START') {
    (async () => {
      try {
        const tab = await getActiveTab();
        if (!tab?.id || !tab.url) throw new Error('未找到当前标签页。');

        const options = normalizeOptions(message.options || {});
        const payload = await capturePage(tab.id, options);
        const archive = await buildArchive(payload, options, tab.url);
        const filename = sanitizeFilename(`${archive.folderName}.zip`);
        const url = await bytesToDataUrl(archive.bytes, 'application/zip');
        await chrome.downloads.download({ url, filename, saveAs: true });
        sendResponse({ ok: true, filename });
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return true;
  }

  if (message?.type === 'ARCHIVE_CAPTURE_CHUNK') {
    const entry = pendingCaptures.get(message.requestId);
    if (!entry) {
      sendResponse?.({ ok: false });
      return false;
    }
    entry.chunks[message.index] = message.chunk || '';
    touchCaptureTimeout(message.requestId);
    sendResponse?.({ ok: true });
    return false;
  }

  if (message?.type === 'ARCHIVE_CAPTURE_DONE') {
    const entry = pendingCaptures.get(message.requestId);
    if (!entry) {
      sendResponse?.({ ok: false });
      return false;
    }
    try {
      clearTimeout(entry.timeoutId);
      const joined = entry.chunks.join('');
      const payload = JSON.parse(joined);
      pendingCaptures.delete(message.requestId);
      entry.resolve(payload);
      sendResponse?.({ ok: true });
    } catch (error) {
      pendingCaptures.delete(message.requestId);
      entry.reject(new Error(`归档数据组装失败：${error instanceof Error ? error.message : String(error)}`));
      sendResponse?.({ ok: false });
    }
    return false;
  }

  if (message?.type === 'ARCHIVE_CAPTURE_ERROR') {
    const entry = pendingCaptures.get(message.requestId);
    if (!entry) {
      sendResponse?.({ ok: false });
      return false;
    }
    clearTimeout(entry.timeoutId);
    pendingCaptures.delete(message.requestId);
    entry.reject(new Error(message.error || '页面归档失败。'));
    sendResponse?.({ ok: true });
    return false;
  }

  return false;
});

async function getActiveTab() {
  const tabs = await new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (result) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(`获取当前标签页失败：${err.message}`));
        return;
      }
      resolve(Array.isArray(result) ? result : []);
    });
  });
  return tabs[0] || null;
}

async function executeScriptFile(tabId, file) {
  return await new Promise((resolve, reject) => {
    chrome.scripting.executeScript({
      target: { tabId },
      files: [file],
      world: 'ISOLATED'
    }, (result) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(`注入脚本失败：${err.message}`));
        return;
      }
      resolve(Array.isArray(result) ? result : []);
    });
  });
}

function normalizeOptions(options) {
  const concurrency = Number(options.fetchConcurrency);
  const maxRetries = Number(options.maxRetries);
  const requestTimeoutMs = Number(options.requestTimeoutMs);
  return {
    fetchConcurrency: Number.isFinite(concurrency) && concurrency > 0 ? Math.min(Math.max(concurrency, 1), 24) : 8,
    maxRetries: Number.isFinite(maxRetries) && maxRetries >= 0 ? Math.min(Math.max(Math.floor(maxRetries), 0), 4) : 2,
    requestTimeoutMs: Number.isFinite(requestTimeoutMs) && requestTimeoutMs >= 3000 ? Math.min(Math.max(Math.floor(requestTimeoutMs), 3000), 45000) : 12000,
    includeScripts: options.includeScripts !== false,
    includeStyles: options.includeStyles !== false,
    includeMedia: options.includeMedia !== false
  };
}

async function capturePage(tabId, options) {
  await executeScriptFile(tabId, CAPTURE_FILE);

  const requestId = `archive_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const payloadPromise = new Promise((resolve, reject) => {
    pendingCaptures.set(requestId, {
      resolve,
      reject,
      chunks: [],
      timeoutId: null
    });
    touchCaptureTimeout(requestId);
  });

  const startResult = await new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'ARCHIVE_CAPTURE_RUN', options, requestId }, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(`页面通信失败：${err.message}`));
        return;
      }
      resolve(response || null);
    });
  }).catch((error) => {
    clearPendingCapture(requestId);
    throw error;
  });

  if (!startResult?.ok) {
    clearPendingCapture(requestId);
    throw new Error(startResult?.error || '未能启动页面归档。');
  }

  return await payloadPromise;
}

function touchCaptureTimeout(requestId) {
  const entry = pendingCaptures.get(requestId);
  if (!entry) return;
  clearTimeout(entry.timeoutId);
  entry.timeoutId = setTimeout(() => {
    const current = pendingCaptures.get(requestId);
    if (!current) return;
    pendingCaptures.delete(requestId);
    current.reject(new Error('页面归档数据回传超时。请关闭部分选项后重试。'));
  }, 120000);
}

function clearPendingCapture(requestId) {
  const entry = pendingCaptures.get(requestId);
  if (!entry) return;
  clearTimeout(entry.timeoutId);
  pendingCaptures.delete(requestId);
}

async function buildArchive(payload, options, pageUrl) {
  const folderName = buildFolderName(payload.title || 'site');
  const files = [];
  const resourceMap = new Map();
  const pathByUrl = new Map();
  const usedPaths = new Set();
  const failures = [];

  const queueResults = await mapWithConcurrency(payload.resources || [], options.fetchConcurrency, async (resource, index) => {
    try {
      const output = await fetchResource(resource, index, { usedPaths, pathByUrl, options });
      return { ok: true, output };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), resource };
    }
  });

  for (const item of queueResults) {
    if (!item.ok) {
      failures.push({ url: item.resource.url, error: item.error, kind: item.resource.kind });
      continue;
    }

    resourceMap.set(item.output.url, item.output.localPath);
    if (!item.output.skipWrite) files.push({ path: `${folderName}/${item.output.localPath}`, bytes: item.output.bytes });

    if (Array.isArray(item.output.extraFiles)) {
      for (const extra of item.output.extraFiles) files.push({ path: `${folderName}/${extra.path}`, bytes: extra.bytes });
    }

    if (item.output.extraMap instanceof Map) {
      for (const [absolute, localPath] of item.output.extraMap.entries()) resourceMap.set(absolute, localPath);
    }
  }

  let html = rewriteHtml(payload.html || '', resourceMap);
  html = injectMetaComment(html, { pageUrl, capturedAt: payload.capturedAt });
  files.push({ path: `${folderName}/index.html`, bytes: encodeText(html) });

  const metadata = {
    sourceUrl: pageUrl,
    title: payload.title,
    capturedAt: payload.capturedAt,
    options,
    resourceCount: payload.resources?.length || 0,
    downloadedCount: resourceMap.size,
    failedCount: failures.length,
    failures
  };
  files.push({ path: `${folderName}/metadata.json`, bytes: encodeText(JSON.stringify(metadata, null, 2)) });

  if (payload.debug) {
    files.push({ path: `${folderName}/debug.json`, bytes: encodeText(JSON.stringify(payload.debug, null, 2)) });
  }

  const zipBytes = buildZip(files);
  return { folderName, bytes: zipBytes };
}

async function fetchResource(resource, index, ctx) {
  if (ctx.pathByUrl.has(resource.url)) {
    return { url: resource.url, localPath: ctx.pathByUrl.get(resource.url), bytes: new Uint8Array(), skipWrite: true, extraFiles: [], extraMap: new Map() };
  }

  const response = await fetchWithRetry(resource.url, ctx.options);
  if (!response.ok) throw new Error(`HTTP_${response.status}`);

  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || '';
  const extension = guessExtension(resource.url, contentType, resource.kind);
  const baseName = basenameFromUrl(resource.url) || `resource-${index + 1}`;
  const safeName = sanitizeFilename(baseName.replace(/\.[^.]+$/, '')) || `resource-${index + 1}`;
  let localPath = buildLocalPath(resource.kind, `${safeName}${extension}`);
  localPath = ensureUniquePath(localPath, ctx.usedPaths);
  ctx.pathByUrl.set(resource.url, localPath);

  if ((contentType.includes('text/css') || extension === '.css') && bytes.length > 0) {
    const cssText = new TextDecoder().decode(bytes);
    const { text, nestedFiles, nestedMap } = await inlineCssAssets(cssText, resource.url, index, localPath, ctx, ctx.options);
    localPath = ensureExtension(localPath, '.css');
    ctx.pathByUrl.set(resource.url, localPath);
    return { url: resource.url, localPath, bytes: encodeText(text), extraFiles: nestedFiles, extraMap: nestedMap, skipWrite: false };
  }

  return { url: resource.url, localPath, bytes, extraFiles: [], extraMap: new Map(), skipWrite: false };
}

function buildLocalPath(kind, filename) {
  switch (kind) {
    case 'style': return `assets/css/${filename}`;
    case 'script': return `assets/js/${filename}`;
    case 'document': return `assets/docs/${filename}`;
    case 'font': return `assets/fonts/${filename}`;
    default: return `assets/media/${filename}`;
  }
}

async function inlineCssAssets(cssText, cssUrl, seed, cssLocalPath, ctx, options) {
  const nestedMap = new Map();
  const nestedFiles = [];
  let transformed = String(cssText || '');
  let nestedIndex = 0;

  const importRegex = /@import\s+(?:url\()?\s*(['"]?)([^'"\)]+)\s*\)?([^;]*);/gi;
  transformed = await replaceAsync(transformed, importRegex, async (full, _quote, rawUrl, trailing) => {
    const absolute = absoluteUrlFrom(rawUrl, cssUrl);
    if (!absolute) return full;
    if (ctx.pathByUrl.has(absolute)) {
      const localPath = ctx.pathByUrl.get(absolute);
      nestedMap.set(absolute, localPath);
      return `@import url("${toCssRelativePath(cssLocalPath, localPath)}")${trailing || ''};`;
    }
    try {
      const response = await fetchWithRetry(absolute, options);
      if (!response.ok) return full;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const importedText = new TextDecoder().decode(bytes);
      const importedName = makeSafeAssetName(absolute, `css-import-${seed + 1}-${nestedIndex + 1}`, '.css');
      const localPath = ensureUniquePath(`assets/css/${importedName}`, ctx.usedPaths);
      ctx.pathByUrl.set(absolute, localPath);
      const nested = await inlineCssAssets(importedText, absolute, seed + nestedIndex + 1, localPath, ctx, options);
      nestedFiles.push({ path: localPath, bytes: encodeText(nested.text) }, ...nested.nestedFiles);
      nestedMap.set(absolute, localPath);
      for (const [k, v] of nested.nestedMap.entries()) nestedMap.set(k, v);
      nestedIndex += 1;
      return `@import url("${toCssRelativePath(cssLocalPath, localPath)}")${trailing || ''};`;
    } catch {
      return full;
    }
  });

  const urlRegex = /url\(([^)]+)\)/gi;
  transformed = await replaceAsync(transformed, urlRegex, async (full, inner) => {
    const raw = String(inner || '').trim().replace(/^['"]|['"]$/g, '');
    if (!raw || /^(data:|blob:|#)/i.test(raw)) return full;
    const absolute = absoluteUrlFrom(raw, cssUrl);
    if (!absolute) return full;
    if (ctx.pathByUrl.has(absolute)) {
      const localPath = ctx.pathByUrl.get(absolute);
      nestedMap.set(absolute, localPath);
      return `url("${toCssRelativePath(cssLocalPath, localPath)}")`;
    }

    try {
      const response = await fetchWithRetry(absolute, options);
      if (!response.ok) return full;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') || '';
      const folder = contentType.startsWith('font/') || /woff2?|ttf|otf|eot|ttc/i.test(contentType) || /\.(woff2?|ttf|otf|eot|ttc)(\?|#|$)/i.test(absolute) ? 'assets/fonts' : 'assets/media';
      const extension = guessExtension(absolute, contentType, folder.includes('fonts') ? 'font' : 'style-asset');
      const filename = makeSafeAssetName(absolute, `css-asset-${seed + 1}-${nestedIndex + 1}`, extension);
      const localPath = ensureUniquePath(`${folder}/${filename}`, ctx.usedPaths);
      nestedFiles.push({ path: localPath, bytes });
      nestedMap.set(absolute, localPath);
      ctx.pathByUrl.set(absolute, localPath);
      nestedIndex += 1;
      return `url("${toCssRelativePath(cssLocalPath, localPath)}")`;
    } catch {
      return full;
    }
  });

  return { text: transformed, nestedFiles, nestedMap };
}

async function fetchWithRetry(url, options) {
  const maxRetries = Math.max(0, Number(options?.maxRetries || 0));
  const timeoutMs = Math.max(3000, Number(options?.requestTimeoutMs || 12000));
  const retryableStatus = new Set([408, 425, 429, 500, 502, 503, 504]);

  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error('REQUEST_TIMEOUT')), timeoutMs);
    try {
      const response = await fetch(url, { credentials: 'include', signal: controller.signal });
      clearTimeout(timeoutId);
      if (response.ok) return response;
      if (!retryableStatus.has(response.status) || attempt >= maxRetries) return response;
      await sleep(250 * (attempt + 1));
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;
      if (attempt >= maxRetries) break;
      await sleep(250 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('NETWORK_FETCH_FAILED');
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function rewriteHtml(html, resourceMap) {
  let output = String(html || '');
  output = output.replace(/__ARCHIVE_SRCSET__([^\s"'>]+)/g, (_match, encoded) => {
    try {
      const absolute = decodeURIComponent(encoded);
      return resourceMap.get(absolute) || absolute;
    } catch {
      return _match;
    }
  });
  for (const [absolute, localPath] of resourceMap.entries()) {
    output = replaceAllSafe(output, `__ARCHIVE_URL__${absolute}`, localPath);
    output = replaceAllSafe(output, absolute, localPath);
  }
  return output.replace(/\s+,/g, ',').replace(/,\s*,/g, ',');
}

function injectMetaComment(html, meta) {
  const comment = `<!-- archived-from: ${meta.pageUrl} | captured-at: ${meta.capturedAt} -->
`;
  if (html.startsWith('<!DOCTYPE')) {
    const index = html.indexOf('>');
    return `${html.slice(0, index + 1)}
${comment}${html.slice(index + 1)}`;
  }
  return `${comment}${html}`;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await worker(items[current], current);
    }
  }
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, () => run());
  await Promise.all(runners);
  return results;
}

function basenameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    return pathname.split('/').filter(Boolean).pop() || '';
  } catch {
    return '';
  }
}

function guessExtension(url, contentType, kind) {
  const pathname = (() => {
    try { return new URL(url).pathname; } catch { return ''; }
  })();
  const match = pathname.match(/\.([a-zA-Z0-9]{1,8})$/);
  if (match) return `.${match[1].toLowerCase()}`;
  if (/css/i.test(contentType)) return '.css';
  if (/javascript|ecmascript/i.test(contentType)) return '.js';
  if (/html/i.test(contentType)) return '.html';
  if (/svg/i.test(contentType)) return '.svg';
  if (/png/i.test(contentType)) return '.png';
  if (/jpe?g/i.test(contentType)) return '.jpg';
  if (/webp/i.test(contentType)) return '.webp';
  if (/gif/i.test(contentType)) return '.gif';
  if (/avif/i.test(contentType)) return '.avif';
  if (/woff2/i.test(contentType)) return '.woff2';
  if (/woff/i.test(contentType)) return '.woff';
  if (/ttf/i.test(contentType)) return '.ttf';
  if (/otf/i.test(contentType)) return '.otf';
  if (/eot/i.test(contentType)) return '.eot';
  if (/json/i.test(contentType)) return '.json';
  if (/mp4/i.test(contentType)) return '.mp4';
  if (/mpeg|mp3/i.test(contentType)) return '.mp3';
  if (kind === 'style') return '.css';
  if (kind === 'script') return '.js';
  if (kind === 'document') return '.html';
  return '.bin';
}

function sanitizeFilename(value) {
  return String(value || '')
    .replace(/[\/:*?"<>| -]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function ensureUniquePath(path, usedPaths) {
  let candidate = path;
  let counter = 1;
  const extIndex = path.lastIndexOf('.');
  const stem = extIndex >= 0 ? path.slice(0, extIndex) : path;
  const ext = extIndex >= 0 ? path.slice(extIndex) : '';
  while (usedPaths.has(candidate.toLowerCase())) {
    counter += 1;
    candidate = `${stem}-${counter}${ext}`;
  }
  usedPaths.add(candidate.toLowerCase());
  return candidate;
}

function ensureExtension(path, ext) {
  return path.toLowerCase().endsWith(ext.toLowerCase()) ? path : `${path}${ext}`;
}

function makeSafeAssetName(url, fallback, ext) {
  const base = sanitizeFilename((basenameFromUrl(url) || fallback).replace(/\.[^.]+$/, '')) || fallback;
  return `${base}${ext}`;
}

function absoluteUrlFrom(raw, baseUrl) {
  try {
    return new URL(String(raw || '').trim(), baseUrl).href;
  } catch {
    return null;
  }
}

function toCssRelativePath(fromPath, toPath) {
  const fromParts = String(fromPath || '').split('/');
  fromParts.pop();
  const toParts = String(toPath || '').split('/');
  while (fromParts.length && toParts.length && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
  }
  return `${'../'.repeat(fromParts.length)}${toParts.join('/')}`;
}

function replaceAllSafe(text, search, replacement) {
  return String(text || '').split(search).join(replacement);
}

function encodeText(text) {
  return new TextEncoder().encode(String(text || ''));
}

async function replaceAsync(text, regex, replacer) {
  const matches = [];
  text.replace(regex, (...args) => {
    matches.push(args);
    return args[0];
  });
  const replacements = await Promise.all(matches.map((args) => replacer(...args)));
  let index = 0;
  return text.replace(regex, () => replacements[index++]);
}

async function bytesToDataUrl(bytes, mimeType) {
  const base64 = uint8ToBase64(bytes);
  return `data:${mimeType};base64,${base64}`;
}

function uint8ToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function buildFolderName(title) {
  const timestamp = new Date().toISOString().replace(/[.:]/g, '-');
  const safeTitle = sanitizeFilename(title) || 'site';
  return `${safeTitle}-${timestamp}`;
}

function buildZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  files.forEach((file) => {
    const nameBytes = encoder.encode(file.path);
    const dataBytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes || []);
    const crc = crc32(dataBytes);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0, true);
    localView.setUint32(14, crc >>> 0, true);
    localView.setUint32(18, dataBytes.length, true);
    localView.setUint32(22, dataBytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);
    localParts.push(localHeader, dataBytes);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0, true);
    centralView.setUint32(16, crc >>> 0, true);
    centralView.setUint32(20, dataBytes.length, true);
    centralView.setUint32(24, dataBytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);

    offset += localHeader.length + dataBytes.length;
  });

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endHeader = new Uint8Array(22);
  const endView = new DataView(endHeader.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  const totalLength = [...localParts, ...centralParts, endHeader].reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(totalLength);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, endHeader]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

function crc32(bytes) {
  let crc = 0 ^ -1;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();
