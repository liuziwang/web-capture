const STORAGE_KEYS = {
  concurrency: 'archiveFetchConcurrency',
  includeScripts: 'archiveIncludeScripts',
  includeStyles: 'archiveIncludeStyles',
  includeMedia: 'archiveIncludeMedia',
  carouselMode: 'archiveCarouselMode',
  styleFidelity: 'archiveStyleFidelity',
  imagesOnly: 'archiveImagesOnly'
};

const defaults = {
  [STORAGE_KEYS.concurrency]: '8',
  [STORAGE_KEYS.includeScripts]: false,
  [STORAGE_KEYS.includeStyles]: true,
  [STORAGE_KEYS.includeMedia]: true,
  [STORAGE_KEYS.carouselMode]: 'visual',
  [STORAGE_KEYS.styleFidelity]: 'basic',
  [STORAGE_KEYS.imagesOnly]: false
};

const concurrencyEl = document.getElementById('fetchConcurrency');
const includeScriptsEl = document.getElementById('includeScripts');
const includeStylesEl = document.getElementById('includeStyles');
const includeMediaEl = document.getElementById('includeMedia');
const carouselModeEl = document.getElementById('carouselMode');
const styleFidelityEl = document.getElementById('styleFidelity');
const imagesOnlyEl = document.getElementById('imagesOnly');
const captureBtn = document.getElementById('captureBtn');
const statusEl = document.getElementById('status');

function setStatus(message) {
  statusEl.textContent = message || '';
}

function setBusy(busy) {
  captureBtn.disabled = busy;
  captureBtn.textContent = busy ? '归档中...' : '开始归档并下载';
}

function readOptions() {
  const imagesOnly = imagesOnlyEl.checked;
  return {
    fetchConcurrency: Number(concurrencyEl.value || defaults[STORAGE_KEYS.concurrency]),
    includeScripts: imagesOnly ? false : includeScriptsEl.checked,
    includeStyles: imagesOnly ? false : includeStylesEl.checked,
    includeMedia: true,
    carouselMode: carouselModeEl.value || defaults[STORAGE_KEYS.carouselMode],
    styleFidelity: styleFidelityEl.value || defaults[STORAGE_KEYS.styleFidelity],
    imagesOnly
  };
}

function persistOptions() {
  const options = readOptions();
  chrome.storage.local.set({
    [STORAGE_KEYS.concurrency]: String(options.fetchConcurrency),
    [STORAGE_KEYS.includeScripts]: options.includeScripts,
    [STORAGE_KEYS.includeStyles]: options.includeStyles,
    [STORAGE_KEYS.includeMedia]: options.includeMedia,
    [STORAGE_KEYS.carouselMode]: options.carouselMode,
    [STORAGE_KEYS.styleFidelity]: options.styleFidelity,
    [STORAGE_KEYS.imagesOnly]: options.imagesOnly
  });
}

function syncToggleState() {
  const locked = imagesOnlyEl.checked;
  includeScriptsEl.disabled = locked;
  includeStylesEl.disabled = locked;
  includeMediaEl.disabled = locked;
  if (locked) includeMediaEl.checked = true;
}

chrome.storage.local.get(defaults, (stored) => {
  concurrencyEl.value = String(stored[STORAGE_KEYS.concurrency] || defaults[STORAGE_KEYS.concurrency]);
  includeScriptsEl.checked = Boolean(stored[STORAGE_KEYS.includeScripts]);
  includeStylesEl.checked = Boolean(stored[STORAGE_KEYS.includeStyles]);
  includeMediaEl.checked = Boolean(stored[STORAGE_KEYS.includeMedia]);
  carouselModeEl.value = String(stored[STORAGE_KEYS.carouselMode] || defaults[STORAGE_KEYS.carouselMode]);
  styleFidelityEl.value = String(stored[STORAGE_KEYS.styleFidelity] || defaults[STORAGE_KEYS.styleFidelity]);
  imagesOnlyEl.checked = Boolean(stored[STORAGE_KEYS.imagesOnly]);
  syncToggleState();
});

[concurrencyEl, includeScriptsEl, includeStylesEl, includeMediaEl, carouselModeEl, styleFidelityEl, imagesOnlyEl].forEach((el) => {
  el.addEventListener('change', persistOptions);
});
imagesOnlyEl.addEventListener('change', syncToggleState);

captureBtn.addEventListener('click', () => {
  setBusy(true);
  setStatus('');

  chrome.runtime.sendMessage({ type: 'ARCHIVE_PAGE_START', options: readOptions() }, (response) => {
    setBusy(false);

    if (chrome.runtime.lastError) {
      setStatus(`归档失败：${chrome.runtime.lastError.message}`);
      return;
    }

    if (!response?.ok) {
      setStatus(`归档失败：${response?.error || '未知错误'}`);
      return;
    }

    setStatus(`已开始下载：${response.filename}`);
    setTimeout(() => window.close(), 500);
  });
});
