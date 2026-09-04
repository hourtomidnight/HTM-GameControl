// Media library client.
//
// Rendering/formatting helpers are PURE functions so they can be unit-tested
// under Node with no DOM. Everything else runs only in the browser branch below.

function formatBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(1) + ' ' + units[i];
}

function pickerUrl(basePath) {
  return basePath + '?pick=1';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderFileList(files, usageByPath) {
  usageByPath = usageByPath || {};
  return (files || []).map((f) => {
    const usedBy = usageByPath[f.path] || 0;
    return `<tr class="media-row${f.missing ? ' missing' : ''}" data-path="${esc(f.path)}">
      <td><audio controls preload="none" src="/media/${esc(f.path)}"></audio></td>
      <td class="path-cell">${esc(f.path)}</td>
      <td class="editable-title" data-path="${esc(f.path)}">${esc(f.title)}</td>
      <td class="editable-tags" data-path="${esc(f.path)}">${esc(f.tags)}</td>
      <td>${formatBytes(f.bytes)}</td>
      <td>used by ${usedBy} hint${usedBy === 1 ? '' : 's'}</td>
      <td>${f.missing ? '<span class="badge missing">Missing</span>' : ''}</td>
      <td><button class="btn-del-media" data-path="${esc(f.path)}">Delete</button></td>
    </tr>`;
  }).join('');
}

function renderUsageBar(usage) {
  usage = usage || {};
  const bytes = usage.bytes;
  const count = usage.count;
  const free = usage.freeBytes == null ? 'unknown' : formatBytes(usage.freeBytes);
  return `<div class="usage-bar">${formatBytes(bytes)} across ${count} file${count === 1 ? '' : 's'} — ${free} free</div>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { formatBytes, renderFileList, renderUsageBar, pickerUrl };
} else {
  // ── DOM ───────────────────────────────────────────────────────────────────
  const uploadForm   = document.getElementById('upload-form');
  const fileInput    = document.getElementById('upload-file');
  const folderInput  = document.getElementById('upload-folder');
  const uploadStatus = document.getElementById('upload-status');
  const usageBarEl   = document.getElementById('usage-bar');
  const tbody        = document.getElementById('media-tbody');

  const picking = new URLSearchParams(location.search).get('pick') === '1';

  async function loadUsage() {
    try {
      const r = await fetch('/api/media/usage');
      const usage = await r.json();
      usageBarEl.innerHTML = renderUsageBar(usage);
    } catch (e) {}
  }

  async function loadFiles() {
    try {
      const r = await fetch('/api/media');
      const data = await r.json();
      tbody.innerHTML = renderFileList((data && data.files) || []);
    } catch (e) {
      tbody.innerHTML = '';
    }
  }

  async function refresh() {
    await Promise.all([loadFiles(), loadUsage()]);
  }

  if (uploadForm) {
    uploadForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!fileInput.files[0]) return;
      const formData = new FormData();
      formData.append('file', fileInput.files[0]);
      formData.append('folder', folderInput.value.trim());
      uploadStatus.textContent = 'Uploading…';
      try {
        const r = await fetch('/api/media/upload', { method: 'POST', body: formData });
        if (r.ok) {
          uploadStatus.textContent = 'Uploaded.';
          fileInput.value = '';
          await refresh();
        } else {
          const body = await r.json().catch(() => ({}));
          uploadStatus.textContent = 'Upload failed: ' + (body.error || r.status);
        }
      } catch (err) {
        uploadStatus.textContent = 'Upload failed.';
      }
      setTimeout(() => { uploadStatus.textContent = ''; }, 3000);
    });
  }

  async function saveMeta(row, field, value) {
    const path = row.dataset.path;
    const otherField = field === 'title' ? 'tags' : 'title';
    const otherCell = row.querySelector(field === 'title' ? '.editable-tags' : '.editable-title');
    const body = { path };
    body[field] = value;
    body[otherField] = otherCell ? otherCell.textContent.trim() : '';
    try {
      await fetch('/api/media/meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {}
  }

  if (tbody) {
    tbody.addEventListener('click', async (e) => {
      const delBtn = e.target.closest('.btn-del-media');
      if (delBtn) {
        const path = delBtn.dataset.path;
        try {
          const r = await fetch('/api/media?path=' + encodeURIComponent(path), { method: 'DELETE' });
          if (r.ok) {
            await refresh();
          } else if (r.status === 409) {
            const body = await r.json().catch(() => ({}));
            alert('In use: ' + (body.inUse ? JSON.stringify(body.inUse) : 'this file is referenced elsewhere.'));
          }
        } catch (err) {}
        return;
      }

      if (picking) {
        const row = e.target.closest('.media-row');
        if (row && !e.target.closest('.editable-title, .editable-tags, .btn-del-media')) {
          const path = row.dataset.path;
          if (window.opener) window.opener.postMessage({ type: 'media-picked', path }, '*');
          window.close();
        }
      }
    });

    tbody.addEventListener('focusin', (e) => {
      const cell = e.target.closest('.editable-title, .editable-tags');
      if (cell) cell.setAttribute('contenteditable', 'true');
    });

    tbody.addEventListener('focusout', (e) => {
      const titleCell = e.target.closest('.editable-title');
      const tagsCell = e.target.closest('.editable-tags');
      const cell = titleCell || tagsCell;
      if (!cell) return;
      const row = cell.closest('tr');
      saveMeta(row, titleCell ? 'title' : 'tags', cell.textContent.trim());
    });
  }

  refresh();
}
