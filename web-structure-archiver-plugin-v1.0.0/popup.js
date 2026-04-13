const STORAGE_KEYS = {
  concurrency: 'archiveFetchConcurrency',
  maxRetries: 'archiveMaxRetries',
  requestTimeoutMs: 'archiveRequestTimeoutMs',
  includeScripts: 'archiveIncludeScripts',
  includeStyles: 'archiveIncludeStyles',
  includeMedia: 'archiveIncludeMedia'
};

const defaults = {
  [STORAGE_KEYS.concurrency]: '8',
  [STORAGE_KEYS.maxRetries]: '2',
  [STORAGE_KEYS.requestTimeoutMs]: '12000',
  [STORAGE_KEYS.includeScripts]: false,
  [STORAGE_KEYS.includeStyles]: true,
  [STORAGE_KEYS.includeMedia]: true
};

const concurrencyEl = document.getElementById('fetchConcurrency');
const maxRetriesEl = document.getElementById('maxRetries');
const requestTimeoutEl = document.getElementById('requestTimeoutMs');
const includeScriptsEl = document.getElementById('includeScripts');
const includeStylesEl = document.getElementById('includeStyles');
const includeMediaEl = document.getElementById('includeMedia');
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
  return {
    fetchConcurrency: Number(concurrencyEl.value || defaults[STORAGE_KEYS.concurrency]),
    maxRetries: Number(maxRetriesEl.value || defaults[STORAGE_KEYS.maxRetries]),
    requestTimeoutMs: Number(requestTimeoutEl.value || defaults[STORAGE_KEYS.requestTimeoutMs]),
    includeScripts: includeScriptsEl.checked,
    includeStyles: includeStylesEl.checked,
    includeMedia: includeMediaEl.checked
  };
}

function persistOptions() {
  const options = readOptions();
  chrome.storage.local.set({
    [STORAGE_KEYS.concurrency]: String(options.fetchConcurrency),
    [STORAGE_KEYS.maxRetries]: String(options.maxRetries),
    [STORAGE_KEYS.requestTimeoutMs]: String(options.requestTimeoutMs),
    [STORAGE_KEYS.includeScripts]: options.includeScripts,
    [STORAGE_KEYS.includeStyles]: options.includeStyles,
    [STORAGE_KEYS.includeMedia]: options.includeMedia
  });
}

chrome.storage.local.get(defaults, (stored) => {
  concurrencyEl.value = String(stored[STORAGE_KEYS.concurrency] || defaults[STORAGE_KEYS.concurrency]);
  maxRetriesEl.value = String(stored[STORAGE_KEYS.maxRetries] || defaults[STORAGE_KEYS.maxRetries]);
  requestTimeoutEl.value = String(stored[STORAGE_KEYS.requestTimeoutMs] || defaults[STORAGE_KEYS.requestTimeoutMs]);
  includeScriptsEl.checked = Boolean(stored[STORAGE_KEYS.includeScripts]);
  includeStylesEl.checked = Boolean(stored[STORAGE_KEYS.includeStyles]);
  includeMediaEl.checked = Boolean(stored[STORAGE_KEYS.includeMedia]);
});

[concurrencyEl, maxRetriesEl, requestTimeoutEl, includeScriptsEl, includeStylesEl, includeMediaEl].forEach((el) => {
  el.addEventListener('change', persistOptions);
});

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
