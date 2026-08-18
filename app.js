// ==========================================================================
// Storage layer — IndexedDB. This is real on-device persistence: entries and
// their photos survive closing the app, restarting the phone, etc. Nothing
// here is ever sent anywhere; it's local to this browser/device only.
// ==========================================================================
const DB_NAME = 'mhc-billing-db';
const DB_VERSION = 1;

function openDb(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e)=>{
      const db = e.target.result;
      if(!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath:'id' });
      if(!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath:'key' });
    };
    req.onsuccess = ()=>resolve(req.result);
    req.onerror = ()=>reject(req.error);
  });
}
const dbPromise = openDb();

async function idbGetAllEntries(){
  const db = await dbPromise;
  return new Promise((resolve, reject)=>{
    const tx = db.transaction('entries', 'readonly');
    const req = tx.objectStore('entries').getAll();
    req.onsuccess = ()=>resolve(req.result || []);
    req.onerror = ()=>reject(req.error);
  });
}
async function idbPutEntry(entry){
  const db = await dbPromise;
  return new Promise((resolve, reject)=>{
    const tx = db.transaction('entries', 'readwrite');
    tx.objectStore('entries').put(entry);
    tx.oncomplete = ()=>resolve();
    tx.onerror = ()=>reject(tx.error);
  });
}
async function idbDeleteEntry(id){
  const db = await dbPromise;
  return new Promise((resolve, reject)=>{
    const tx = db.transaction('entries', 'readwrite');
    tx.objectStore('entries').delete(id);
    tx.oncomplete = ()=>resolve();
    tx.onerror = ()=>reject(tx.error);
  });
}
async function idbGetSetting(key){
  const db = await dbPromise;
  return new Promise((resolve, reject)=>{
    const tx = db.transaction('settings', 'readonly');
    const req = tx.objectStore('settings').get(key);
    req.onsuccess = ()=>resolve(req.result ? req.result.value : undefined);
    req.onerror = ()=>reject(req.error);
  });
}
async function idbSetSetting(key, value){
  const db = await dbPromise;
  return new Promise((resolve, reject)=>{
    const tx = db.transaction('settings', 'readwrite');
    tx.objectStore('settings').put({ key, value });
    tx.oncomplete = ()=>resolve();
    tx.onerror = ()=>reject(tx.error);
  });
}
function genId(){
  return 'e_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// ==========================================================================
// App state
// ==========================================================================
let entries = [];
let selected = new Set();
let clinicianName = '';
let editingId = null;
let currentPhotoDataUrl = null;

const dateInput = document.getElementById('dateInput');
dateInput.value = new Date().toISOString().slice(0, 10);

// ---- MBS item rows (supports comma-separated or multiple rows) ----
function renderMbsRows(values){
  const container = document.getElementById('mbsRows');
  container.innerHTML = '';
  const list = (values && values.length) ? values : [''];
  list.forEach((val)=>{
    const row = document.createElement('div');
    row.className = 'mbs-row';
    row.innerHTML = `<input type="text" class="mbs-row-input" placeholder="e.g. 55126" inputmode="numeric" value="${val ? escapeHtml(val) : ''}">`;
    container.appendChild(row);
  });
  refreshMbsRemoveButtons();
}
function refreshMbsRemoveButtons(){
  const rows = document.querySelectorAll('#mbsRows .mbs-row');
  rows.forEach((row)=>{
    let btn = row.querySelector('.mbs-remove-btn');
    if(rows.length > 1 && !btn){
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mbs-remove-btn';
      btn.setAttribute('aria-label', 'Remove item number');
      btn.textContent = '×';
      btn.addEventListener('click', ()=>{
        row.remove();
        if(!document.querySelectorAll('.mbs-row-input').length) renderMbsRows(['']);
        refreshMbsRemoveButtons();
      });
      row.appendChild(btn);
    } else if(rows.length === 1 && btn){
      btn.remove();
    }
  });
}
document.getElementById('addMbsRowBtn').addEventListener('click', ()=>{
  const row = document.createElement('div');
  row.className = 'mbs-row';
  row.innerHTML = `<input type="text" class="mbs-row-input" placeholder="e.g. 55126" inputmode="numeric">`;
  document.getElementById('mbsRows').appendChild(row);
  refreshMbsRemoveButtons();
  row.querySelector('input').focus();
});
function collectMbsValues(){
  const raw = Array.from(document.querySelectorAll('.mbs-row-input')).map((i)=>i.value);
  const items = raw.flatMap((v)=>v.split(',')).map((v)=>v.trim()).filter((v)=>v.length);
  return [...new Set(items)];
}
renderMbsRows(['']);

// ---- Photo capture (downscaled before storage, since it now persists indefinitely) ----
function renderPhotoZone(){
  const zone = document.getElementById('photoZone');
  if(currentPhotoDataUrl){
    zone.innerHTML = `
      <div class="photo-preview">
        <img src="${currentPhotoDataUrl}" alt="Captured patient label">
        <button class="retake-btn" id="retakeBtn">Retake</button>
      </div>`;
    document.getElementById('retakeBtn').onclick = ()=>document.getElementById('photoInput').click();
  } else {
    zone.innerHTML = `
      <div class="photo-target" id="photoTarget">
        <div class="glyph">📷</div>
        <div class="hint">Tap to photograph Bradma sticker</div>
        <div class="sub">Stored on this device only</div>
      </div>`;
    document.getElementById('photoTarget').onclick = ()=>document.getElementById('photoInput').click();
  }
}
renderPhotoZone();

function downscaleImage(dataUrl, maxDim = 1600, quality = 0.85){
  return new Promise((resolve)=>{
    const img = new Image();
    img.onload = ()=>{
      let { width, height } = img;
      if(width > maxDim || height > maxDim){
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = ()=>resolve(dataUrl); // fall back to original if it can't be processed
    img.src = dataUrl;
  });
}

document.getElementById('photoInput').addEventListener('change', (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = async ()=>{
    currentPhotoDataUrl = await downscaleImage(reader.result);
    renderPhotoZone();
  };
  reader.readAsDataURL(file);
});

// ---- Save / update entry ----
document.getElementById('saveBtn').addEventListener('click', async ()=>{
  const err = document.getElementById('formErr');
  const mbsList = collectMbsValues();
  const date = dateInput.value;
  const location = document.getElementById('locationInput').value;
  const note = document.getElementById('noteInput').value.trim();

  if(!currentPhotoDataUrl){ err.textContent = 'Add a photo of the patient label first.'; return; }
  if(!date){ err.textContent = 'Select a date.'; return; }
  if(!location){ err.textContent = 'Select a location.'; return; }
  if(!mbsList.length){ err.textContent = 'Enter at least one MBS item number.'; return; }
  err.textContent = '';

  try{
    if(editingId !== null){
      const e = entries.find((x)=>x.id === editingId);
      if(e){
        e.photo = currentPhotoDataUrl;
        e.date = date; e.location = location; e.mbsList = mbsList; e.note = note;
        await idbPutEntry(e);
      }
      showToast('Entry updated');
      editingId = null;
    } else {
      const entry = {
        id: genId(), photo: currentPhotoDataUrl, date, location, mbsList, note,
        status: 'pending', createdAt: new Date()
      };
      entries.unshift(entry);
      await idbPutEntry(entry);
      showToast('Entry saved');
    }
  } catch(saveErr){
    err.textContent = 'Could not save to device storage — try again.';
    return;
  }

  resetForm();
  renderLists();
});

document.getElementById('cancelEditBtn').addEventListener('click', ()=>{
  editingId = null;
  resetForm();
});

function resetForm(){
  currentPhotoDataUrl = null;
  renderPhotoZone();
  renderMbsRows(['']);
  document.getElementById('noteInput').value = '';
  document.getElementById('locationInput').value = '';
  dateInput.value = new Date().toISOString().slice(0, 10);
  document.getElementById('formErr').textContent = '';
  document.getElementById('entryFormTitle').textContent = 'New billing entry';
  document.getElementById('saveBtn').textContent = 'Save entry';
  document.getElementById('cancelEditBtn').style.display = 'none';
}

function startEdit(id){
  const e = entries.find((x)=>x.id === id);
  if(!e) return;
  editingId = id;
  currentPhotoDataUrl = e.photo;
  renderPhotoZone();
  dateInput.value = e.date;
  document.getElementById('locationInput').value = e.location || '';
  renderMbsRows(e.mbsList && e.mbsList.length ? e.mbsList : ['']);
  document.getElementById('noteInput').value = e.note || '';
  document.getElementById('formErr').textContent = '';
  document.getElementById('entryFormTitle').textContent = 'Edit billing entry';
  document.getElementById('saveBtn').textContent = 'Update entry';
  document.getElementById('cancelEditBtn').style.display = 'block';
  closeModal();
  document.getElementById('entryFormCard').scrollIntoView({ behavior:'smooth', block:'start' });
}

// ---- Lists, selection, bulk actions ----
function renderLists(){
  const pending = entries.filter((e)=>e.status === 'pending');
  const billed = entries.filter((e)=>e.status === 'billed');

  const pendingIds = new Set(pending.map((e)=>e.id));
  Array.from(selected).forEach((id)=>{ if(!pendingIds.has(id)) selected.delete(id); });

  document.getElementById('pendingCount').textContent = pending.length;
  document.getElementById('billedCount').textContent = billed.length;

  const pendingList = document.getElementById('pendingList');
  const billedList = document.getElementById('billedList');

  pendingList.innerHTML = pending.length ? '' : `<div class="empty">No pending entries. Add one above to start today's list.</div>`;
  billedList.innerHTML = billed.length ? '' : `<div class="empty">Nothing billed yet.</div>`;

  pending.forEach((e)=>pendingList.appendChild(buildEntryRow(e, true)));
  billed.forEach((e)=>billedList.appendChild(buildEntryRow(e, false)));

  const selectAllBox = document.getElementById('selectAllPending');
  document.getElementById('selectAllWrap').style.display = pending.length ? 'flex' : 'none';
  if(pending.length){
    const selectedPendingCount = pending.filter((e)=>selected.has(e.id)).length;
    selectAllBox.checked = selectedPendingCount === pending.length;
    selectAllBox.indeterminate = selectedPendingCount > 0 && selectedPendingCount < pending.length;
  }
  updateBulkBar();
}

function updateBulkBar(){
  const bar = document.getElementById('bulkBar');
  const count = selected.size;
  if(count === 0){ bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  document.getElementById('bulkCount').textContent = `${count} selected`;
}

function buildEntryRow(e, selectable){
  const row = document.createElement('div');
  row.className = 'entry';
  const checkboxHtml = selectable ? `<input type="checkbox" ${selected.has(e.id) ? 'checked' : ''} data-id="${e.id}" class="rowcheck" onclick="event.stopPropagation()">` : '';
  row.innerHTML = `
    ${checkboxHtml}
    <img src="${e.photo}" alt="">
    <div class="entry-body">
      <div class="entry-mbs">MBS ${escapeHtml((e.mbsList || []).join(', '))}</div>
      <div class="entry-meta">${formatDate(e.date)} · ${escapeHtml(e.location || '—')}${e.note ? ' · ' + escapeHtml(e.note) : ''}</div>
    </div>
    <span class="badge ${e.status === 'billed' ? 'badge-billed' : 'badge-pending'}">${e.status === 'billed' ? 'Billed' : 'Pending'}</span>
  `;
  row.addEventListener('click', ()=>openDetail(e.id));
  const cb = row.querySelector('.rowcheck');
  if(cb){
    cb.addEventListener('change', ()=>{
      if(cb.checked) selected.add(e.id); else selected.delete(e.id);
      syncSelectAllState();
      updateBulkBar();
    });
  }
  return row;
}

function syncSelectAllState(){
  const pending = entries.filter((e)=>e.status === 'pending');
  const selectAllBox = document.getElementById('selectAllPending');
  if(!pending.length) return;
  const selectedPendingCount = pending.filter((e)=>selected.has(e.id)).length;
  selectAllBox.checked = selectedPendingCount === pending.length;
  selectAllBox.indeterminate = selectedPendingCount > 0 && selectedPendingCount < pending.length;
}

function formatDate(d){
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('en-AU', { day:'2-digit', month:'short', year:'numeric' });
}
function slugify(s){
  return (s || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
function escapeHtml(s){
  return s.replace(/[&<>"']/g, (c)=>({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function showToast(msg){
  const root = document.getElementById('toastRoot');
  root.innerHTML = `<div class="toast">${msg}</div>`;
  setTimeout(()=>{ root.innerHTML = ''; }, 2400);
}

// ---- Detail modal ----
function openDetail(id){
  const e = entries.find((x)=>x.id === id);
  if(!e) return;
  const root = document.getElementById('modalRoot');
  root.innerHTML = `
    <div class="overlay" id="overlay">
      <div class="sheet">
        <button class="sheet-close" id="closeSheet">✕</button>
        <h3>MBS ${escapeHtml((e.mbsList || []).join(', '))}</h3>
        <img class="full" src="${e.photo}" alt="Patient label">
        <div class="detail-row"><span class="k">Date</span><span class="v">${formatDate(e.date)}</span></div>
        <div class="detail-row"><span class="k">Location</span><span class="v">${escapeHtml(e.location || '—')}</span></div>
        <div class="detail-row"><span class="k">MBS item(s)</span><span class="v">${escapeHtml((e.mbsList || []).join(', '))}</span></div>
        <div class="detail-row"><span class="k">Note</span><span class="v">${e.note ? escapeHtml(e.note) : '—'}</span></div>
        <div class="detail-row"><span class="k">Status</span><span class="v">${e.status === 'billed' ? 'Billed' : 'Pending'}</span></div>
        ${e.status === 'billed' && e.billedAt ? `<div class="detail-row"><span class="k">Billed at</span><span class="v">${new Date(e.billedAt).toLocaleString('en-AU')}</span></div>` : ''}
        <div class="btn-row">
          <button class="btn btn-primary btn-sm" id="pdfBtn">Generate PDF</button>
          <button class="btn btn-ghost btn-sm" id="toggleStatusBtn">${e.status === 'billed' ? 'Mark pending' : 'Mark billed'}</button>
        </div>
        ${e.status === 'pending' ? `
        <div class="btn-row">
          <button class="btn btn-ghost btn-sm" id="editBtn">Edit entry</button>
        </div>` : ''}
        <div class="btn-row">
          <button class="btn btn-ghost btn-sm" id="deleteBtn" style="color:var(--accent);">Delete entry</button>
        </div>
      </div>
    </div>`;
  document.getElementById('closeSheet').onclick = closeModal;
  document.getElementById('overlay').addEventListener('click', (ev)=>{ if(ev.target.id === 'overlay') closeModal(); });
  document.getElementById('pdfBtn').onclick = ()=>generatePdf([e]);
  const editBtnEl = document.getElementById('editBtn');
  if(editBtnEl) editBtnEl.onclick = ()=>startEdit(e.id);
  document.getElementById('toggleStatusBtn').onclick = async ()=>{
    e.status = e.status === 'billed' ? 'pending' : 'billed';
    if(e.status === 'billed'){ e.billedAt = new Date(); } else { delete e.billedAt; }
    await idbPutEntry(e);
    if(e.status === 'billed') notifyBilled(e); else showToast('Marked as pending');
    closeModal();
    renderLists();
  };
  document.getElementById('deleteBtn').onclick = async ()=>{
    entries = entries.filter((x)=>x.id !== id);
    selected.delete(id);
    await idbDeleteEntry(id);
    closeModal();
    renderLists();
  };
}
function closeModal(){ document.getElementById('modalRoot').innerHTML = ''; }

function notifyBilled(e){
  showToast('Marked as billed');
  try{
    if('Notification' in window){
      if(Notification.permission === 'granted'){
        new Notification('MHC Billing', { body: `MBS ${(e.mbsList || []).join(', ')} (${formatDate(e.date)}) marked billed.` });
      } else if(Notification.permission !== 'denied'){
        Notification.requestPermission();
      }
    }
  }catch(err){ /* local notification unavailable — in-app toast already confirms it */ }
}

// ---- PDF generation ----
async function generatePdf(list){
  if(!list.length) return;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:'pt', format:'a4' });

  list.forEach((e, idx)=>{
    if(idx > 0) doc.addPage();
    doc.setFontSize(16);
    doc.setTextColor(18, 42, 69);
    doc.text('My Heart Cardiology', 40, 50);
    doc.setFontSize(11);
    doc.setTextColor(107, 119, 133);
    doc.text('Inpatient Billing Slip', 40, 68);

    doc.setDrawColor(223, 228, 232);
    doc.line(40, 80, 555, 80);

    doc.setFontSize(11);
    doc.setTextColor(18, 42, 69);
    let y = 108;
    const line = (label, value)=>{
      doc.setTextColor(107, 119, 133);
      doc.text(label, 40, y);
      doc.setTextColor(18, 42, 69);
      const wrapped = doc.splitTextToSize(String(value || '—'), 375);
      doc.text(wrapped, 180, y);
      y += 22 * wrapped.length;
    };
    line('Clinician:', clinicianName || 'Not set');
    line('Date of service:', formatDate(e.date));
    line('Location:', e.location);
    line('MBS item number(s):', (e.mbsList || []).join(', '));
    line('Note:', e.note);
    line('Status:', e.status === 'billed' ? 'Billed' : 'Pending');

    y += 14;
    doc.setFontSize(9.5);
    doc.setTextColor(107, 119, 133);
    doc.text('Patient label (source record):', 40, y);
    y += 10;
    try{
      const fmtMatch = /^data:image\/(jpeg|jpg|png|webp);/i.exec(e.photo);
      const rawFmt = fmtMatch ? fmtMatch[1].toUpperCase() : 'JPEG';
      const fmt = rawFmt === 'JPG' ? 'JPEG' : rawFmt;
      const imgProps = doc.getImageProperties(e.photo);
      const maxW = 515, maxH = 620 - y;
      let w = maxW, h = (imgProps.height / imgProps.width) * maxW;
      if(h > maxH){ h = maxH; w = (imgProps.width / imgProps.height) * maxH; }
      doc.addImage(e.photo, fmt, 40, y, w, h, undefined, 'NONE');
    }catch(err){
      doc.setTextColor(179, 58, 49);
      doc.text('Photo could not be embedded — check the entry in-app.', 40, y + 14);
    }

    doc.setFontSize(8.5);
    doc.setTextColor(150, 158, 166);
    doc.text('Generated on this device — no data transmitted externally.', 40, 800);
  });

  const blob = doc.output('blob');
  const fileName = list.length === 1
    ? `MHC-billing-${list[0].date}-${slugify(list[0].location)}-${(list[0].mbsList || []).join('+')}.pdf`
    : `MHC-billing-batch-${new Date().toISOString().slice(0, 10)}.pdf`;
  const file = new File([blob], fileName, { type:'application/pdf' });
const blobUrl = URL.createObjectURL(blob);
  showPdfReadySheet(file, blobUrl, fileName);
}

function blobToDataUrl(blob){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = ()=>resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function showPdfReadySheet(file, blobUrl, fileName){
  const root = document.getElementById('modalRoot');
  const canShareFile = !!(navigator.canShare && navigator.canShare({ files:[file] }));

  root.innerHTML = `
    <div class="overlay" id="overlay">
      <div class="sheet">
        <button class="sheet-close" id="closeSheet">✕</button>
        <h3>PDF ready</h3>
        <p style="font-size:13.5px;color:var(--muted);line-height:1.5;margin:0 0 14px 0;">${fileName}</p>
        <button class="btn btn-primary" id="shareBtn">${canShareFile ? 'Share to admin' : 'Try share (may not be supported here)'}</button>
        <a href="${blobUrl}" target="_blank" rel="noopener" class="btn btn-ghost" id="saveLink" style="display:block;text-align:center;text-decoration:none;">Open a copy in Safari</a>
        <p class="mbs-hint" style="margin-top:10px;">Opens the PDF in Safari, where you can use its own Share/Save icon.</p>      </div>
    </div>`;

  document.getElementById('shareBtn').onclick = async ()=>{
    if(!(navigator.canShare && navigator.canShare({ files:[file] }))){
      showToast('Sharing files isn\u2019t available here — try "Open / save a copy"');
      return;
    }
    try{
      await navigator.share({ files:[file], title:'MHC Billing Slip' });
      showToast('Shared to admin');
    }catch(err){
      if(err && err.name !== 'AbortError') showToast('Share didn\u2019t go through — try "Open / save a copy" below');
    }
  };
  document.getElementById('closeSheet').onclick = closeModal;
  document.getElementById('overlay').addEventListener('click', (ev)=>{ if(ev.target.id === 'overlay') closeModal(); });
}

// ---- Bulk actions ----
document.getElementById('selectAllPending').addEventListener('change', (ev)=>{
  const pending = entries.filter((e)=>e.status === 'pending');
  if(ev.target.checked) pending.forEach((e)=>selected.add(e.id));
  else pending.forEach((e)=>selected.delete(e.id));
  renderLists();
});

document.getElementById('bulkMarkBilledBtn').addEventListener('click', async ()=>{
  const list = entries.filter((e)=>selected.has(e.id) && e.status === 'pending');
  if(!list.length) return;
  const now = new Date();
  await Promise.all(list.map((e)=>{ e.status = 'billed'; e.billedAt = now; return idbPutEntry(e); }));
  selected.clear();
  showToast(`${list.length} ${list.length === 1 ? 'entry' : 'entries'} marked billed`);
  try{
    if('Notification' in window && Notification.permission === 'granted'){
      new Notification('MHC Billing', { body: `${list.length} ${list.length === 1 ? 'entry' : 'entries'} marked billed.` });
    }
  }catch(err){ /* local notification unavailable — in-app toast already confirms it */ }
  renderLists();
});

document.getElementById('bulkExportBtn').addEventListener('click', ()=>{
  const list = entries.filter((e)=>selected.has(e.id));
  if(!list.length){ showToast('Select entries to export first'); return; }
  generatePdf(list);
});

// ---- Settings ----
document.getElementById('settingsBtn').addEventListener('click', ()=>{
  const root = document.getElementById('modalRoot');
  root.innerHTML = `
    <div class="overlay" id="overlay">
      <div class="sheet">
        <button class="sheet-close" id="closeSheet">✕</button>
        <h3>Settings</h3>
        <label class="field-label first">Clinician name</label>
        <input type="text" id="clinicianInput" placeholder="Dr First Last" value="${clinicianName ? escapeHtml(clinicianName) : ''}">
        <div class="settings-row"><span style="font-size:13px;color:var(--muted);">Appears on generated PDF slips</span></div>
        <button class="btn btn-primary" id="saveSettingsBtn">Save</button>
      </div>
    </div>`;
  document.getElementById('closeSheet').onclick = closeModal;
  document.getElementById('overlay').addEventListener('click', (ev)=>{ if(ev.target.id === 'overlay') closeModal(); });
  document.getElementById('saveSettingsBtn').onclick = async ()=>{
    clinicianName = document.getElementById('clinicianInput').value.trim();
    await idbSetSetting('clinicianName', clinicianName);
    document.getElementById('clinicianLine').textContent = clinicianName ? clinicianName : 'Set your name in settings →';
    closeModal();
    showToast('Settings saved');
  };
});

// ==========================================================================
// Boot
// ==========================================================================
async function init(){
  try{
    const [storedEntries, storedName] = await Promise.all([
      idbGetAllEntries(),
      idbGetSetting('clinicianName')
    ]);
    entries = storedEntries.sort((a, b)=>new Date(b.createdAt) - new Date(a.createdAt));
    clinicianName = storedName || '';
    document.getElementById('clinicianLine').textContent = clinicianName ? clinicianName : 'Set your name in settings →';
  }catch(err){
    showToast('Could not load saved entries from this device');
  }
  renderLists();
}
init();

if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js').catch(()=>{ /* offline support just won't be available */ });
  });
}
