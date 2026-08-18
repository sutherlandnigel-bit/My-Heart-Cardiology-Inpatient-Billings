// ==========================================================================
// Storage layer — IndexedDB, all on-device, nothing ever uploaded anywhere.
//
// Schema (v2):
//   patients       { id, photoThumb, photoFull, ocrText, createdAt }
//   billingEntries { id, patientId, date, location, mbsList, note, status, billedAt, createdAt }
//   settings       { key, value }  -- e.g. clinicianName
//   entries        -- legacy v1 store, read once for migration then left alone
//   practitioners  -- legacy multi-login store from an earlier beta build, no longer
//                     used for filtering; kept only so old installs don't error on open.
// ==========================================================================
const DB_NAME = 'mhc-billing-db';
const DB_VERSION = 2;

function openDb(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e)=>{
      const db = e.target.result;
      if(!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath:'id' });
      if(!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath:'key' });
      if(!db.objectStoreNames.contains('practitioners')) db.createObjectStore('practitioners', { keyPath:'id' });
      if(!db.objectStoreNames.contains('patients')) db.createObjectStore('patients', { keyPath:'id' });
      if(!db.objectStoreNames.contains('billingEntries')) db.createObjectStore('billingEntries', { keyPath:'id' });
    };
    req.onsuccess = ()=>resolve(req.result);
    req.onerror = ()=>reject(req.error);
  });
}
const dbPromise = openDb();

function idbAll(store){
  return dbPromise.then((db)=>new Promise((resolve, reject)=>{
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = ()=>resolve(req.result || []);
    req.onerror = ()=>reject(req.error);
  }));
}
function idbPut(store, value){
  return dbPromise.then((db)=>new Promise((resolve, reject)=>{
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = ()=>resolve();
    tx.onerror = ()=>reject(tx.error);
  }));
}
function idbDelete(store, id){
  return dbPromise.then((db)=>new Promise((resolve, reject)=>{
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    tx.oncomplete = ()=>resolve();
    tx.onerror = ()=>reject(tx.error);
  }));
}
function idbGetSetting(key){
  return dbPromise.then((db)=>new Promise((resolve, reject)=>{
    const req = db.transaction('settings', 'readonly').objectStore('settings').get(key);
    req.onsuccess = ()=>resolve(req.result ? req.result.value : undefined);
    req.onerror = ()=>reject(req.error);
  }));
}
function idbSetSetting(key, value){
  return idbPut('settings', { key, value });
}
function genId(prefix){
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ==========================================================================
// App state
// ==========================================================================
let clinicianName = '';
let patients = [];
let billingEntries = [];
let selected = new Set();
let editingId = null;
let currentPhoto = null;      // { thumb, full } for a photo just captured, before saving
let selectedPatientId = null; // set when reusing an existing patient via the recent-patients strip
let navStack = [];            // simple back-stack for nested sheets (patient history, etc.)

const dateInput = document.getElementById('dateInput');
dateInput.value = new Date().toISOString().slice(0, 10);

function activePatients(){ return patients; }
function activeEntries(){ return billingEntries; }
function findPatient(id){ return patients.find((p)=>p.id === id); }

// ---- MBS item rows ----
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

// ---- Photo capture: keep both a full-quality "backup" copy and a small thumb ----
function downscaleImage(dataUrl, maxDim, quality){
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
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = ()=>resolve(dataUrl);
    img.src = dataUrl;
  });
}

function renderPhotoZone(){
  const zone = document.getElementById('photoZone');
  const recent = activePatients()
    .slice()
    .sort((a, b)=>new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 8);

  let chipsHtml = '';
  if(recent.length && !selectedPatientId && !currentPhoto){
    chipsHtml = `
      <div class="chip-label">Same patient as a recent entry?</div>
      <div class="chip-row" id="recentPatientChips">
        ${recent.map((p)=>`
          <button type="button" class="patient-chip" data-id="${p.id}">
            <img src="${p.photoThumb}" alt="">
          </button>`).join('')}
      </div>`;
  }

  if(selectedPatientId){
    const p = findPatient(selectedPatientId);
    zone.innerHTML = `
      ${chipsHtml}
      <div class="photo-preview">
        <img src="${p ? p.photoThumb : ''}" alt="Selected patient label">
        <button class="retake-btn" id="retakeBtn">Use different patient</button>
      </div>
      <div class="mbs-hint">Using an existing patient's photo — only date and item number(s) needed below.</div>`;
    document.getElementById('retakeBtn').onclick = ()=>{ selectedPatientId = null; renderPhotoZone(); };
  } else if(currentPhoto){
    zone.innerHTML = `
      ${chipsHtml}
      <div class="photo-preview">
        <img src="${currentPhoto.thumb}" alt="Captured patient label">
        <button class="retake-btn" id="retakeBtn">Change photo</button>
      </div>`;
    document.getElementById('retakeBtn').onclick = ()=>{ currentPhoto = null; renderPhotoZone(); };
  } else {
    zone.innerHTML = `
      ${chipsHtml}
      <div class="photo-target" id="photoTarget">
        <div class="glyph">📷</div>
        <div class="hint">Tap to add a patient label photo</div>
        <div class="sub">Take a new photo or choose from your library — stored on this device only</div>
      </div>`;
    document.getElementById('photoTarget').onclick = ()=>document.getElementById('photoInput').click();
  }

  const chipRow = document.getElementById('recentPatientChips');
  if(chipRow){
    chipRow.querySelectorAll('.patient-chip').forEach((btn)=>{
      btn.addEventListener('click', ()=>{
        selectedPatientId = btn.getAttribute('data-id');
        currentPhoto = null;
        renderPhotoZone();
      });
    });
  }
}
renderPhotoZone();

document.getElementById('photoInput').addEventListener('change', (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = async ()=>{
    const [full, thumb] = await Promise.all([
      downscaleImage(reader.result, 1600, 0.88),
      downscaleImage(reader.result, 480, 0.75)
    ]);
    currentPhoto = { full, thumb };
    selectedPatientId = null;
    renderPhotoZone();
  };
  reader.readAsDataURL(file);
});

// ---- Save / update a billing entry ----
document.getElementById('saveBtn').addEventListener('click', async ()=>{
  const err = document.getElementById('formErr');
  const mbsList = collectMbsValues();
  const date = dateInput.value;
  const location = document.getElementById('locationInput').value;
  const note = document.getElementById('noteInput').value.trim();

  if(!selectedPatientId && !currentPhoto){ err.textContent = 'Add a photo, or pick an existing patient above.'; return; }
  if(!date){ err.textContent = 'Select a date.'; return; }
  if(!location){ err.textContent = 'Select a location.'; return; }
  if(!mbsList.length){ err.textContent = 'Enter at least one MBS item number.'; return; }
  err.textContent = '';

  try{
    if(editingId !== null){
      const e = billingEntries.find((x)=>x.id === editingId);
      if(e){
        e.date = date; e.location = location; e.mbsList = mbsList; e.note = note;
        await idbPut('billingEntries', e);
      }
      showToast('Entry updated');
      editingId = null;
    } else {
      let patientId = selectedPatientId;
      if(!patientId){
        const patient = {
          id: genId('pt'),
          photoThumb: currentPhoto.thumb, photoFull: currentPhoto.full,
          ocrText: '', createdAt: new Date()
        };
        patients.unshift(patient);
        await idbPut('patients', patient);
        patientId = patient.id;
      }
      const entry = {
        id: genId('bl'), patientId,
        date, location, mbsList, note, status:'pending', createdAt: new Date()
      };
      billingEntries.unshift(entry);
      await idbPut('billingEntries', entry);
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
  currentPhoto = null;
  selectedPatientId = null;
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
  const e = billingEntries.find((x)=>x.id === id);
  if(!e) return;
  editingId = id;
  selectedPatientId = e.patientId;
  currentPhoto = null;
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

function addAnotherDayFor(patientId){
  closeModal();
  editingId = null;
  selectedPatientId = patientId;
  currentPhoto = null;
  renderPhotoZone();
  document.getElementById('locationInput').value = '';
  renderMbsRows(['']);
  document.getElementById('noteInput').value = '';
  document.getElementById('formErr').textContent = '';
  document.getElementById('entryFormTitle').textContent = 'New billing entry';
  document.getElementById('saveBtn').textContent = 'Save entry';
  document.getElementById('cancelEditBtn').style.display = 'none';
  document.getElementById('entryFormCard').scrollIntoView({ behavior:'smooth', block:'start' });
}

// ---- Lists, selection, bulk actions ----
function renderLists(){
  const all = activeEntries();
  const pending = all.filter((e)=>e.status === 'pending');
  const forwarded = all.filter((e)=>e.status === 'forwarded');
  const billed = all.filter((e)=>e.status === 'billed');
  const selectable = pending.concat(forwarded);

  const selectableIds = new Set(selectable.map((e)=>e.id));
  Array.from(selected).forEach((id)=>{ if(!selectableIds.has(id)) selected.delete(id); });

  document.getElementById('pendingCount').textContent = pending.length;
  document.getElementById('forwardedCount').textContent = forwarded.length;
  document.getElementById('billedCount').textContent = billed.length;

  const pendingList = document.getElementById('pendingList');
  const forwardedList = document.getElementById('forwardedList');
  const billedList = document.getElementById('billedList');
  pendingList.innerHTML = pending.length ? '' : `<div class="empty">No pending entries. Add one above to start today's list.</div>`;
  forwardedList.innerHTML = forwarded.length ? '' : `<div class="empty">Nothing forwarded to admin yet.</div>`;
  billedList.innerHTML = billed.length ? '' : `<div class="empty">Nothing billed yet.</div>`;
  pending.forEach((e)=>pendingList.appendChild(buildEntryRow(e, true)));
  forwarded.forEach((e)=>forwardedList.appendChild(buildEntryRow(e, true)));
  billed.forEach((e)=>billedList.appendChild(buildEntryRow(e, false)));

  const selectAllBox = document.getElementById('selectAllPending');
  document.getElementById('selectAllWrap').style.display = selectable.length ? 'flex' : 'none';
  if(selectable.length){
    const selectedCount = selectable.filter((e)=>selected.has(e.id)).length;
    selectAllBox.checked = selectedCount === selectable.length;
    selectAllBox.indeterminate = selectedCount > 0 && selectedCount < selectable.length;
  }
  updateBulkBar();
  renderPhotoZone(); // recent-patient chips can change as entries are added elsewhere
}

function updateBulkBar(){
  const bar = document.getElementById('bulkBar');
  const count = selected.size;
  if(count === 0){ bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  document.getElementById('bulkCount').textContent = `${count} selected`;
}

function buildEntryRow(e, selectable){
  const p = findPatient(e.patientId);
  const row = document.createElement('div');
  row.className = 'entry';
  const checkboxHtml = selectable ? `<input type="checkbox" ${selected.has(e.id) ? 'checked' : ''} data-id="${e.id}" class="rowcheck" onclick="event.stopPropagation()">` : '';
  row.innerHTML = `
    ${checkboxHtml}
    <img src="${p ? p.photoThumb : ''}" alt="">
    <div class="entry-body">
      <div class="entry-mbs">MBS ${escapeHtml((e.mbsList || []).join(', '))}</div>
      <div class="entry-meta">${formatDate(e.date)} · ${escapeHtml(e.location || '—')}${e.note ? ' · ' + escapeHtml(e.note) : ''}</div>
    </div>
    <span class="badge badge-${e.status}">${statusLabel(e.status)}</span>
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
  const selectable = activeEntries().filter((e)=>e.status === 'pending' || e.status === 'forwarded');
  const selectAllBox = document.getElementById('selectAllPending');
  if(!selectable.length) return;
  const selectedCount = selectable.filter((e)=>selected.has(e.id)).length;
  selectAllBox.checked = selectedCount === selectable.length;
  selectAllBox.indeterminate = selectedCount > 0 && selectedCount < selectable.length;
}

function formatDate(d){
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('en-AU', { day:'2-digit', month:'short', year:'numeric' });
}
function slugify(s){ return (s || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }
function escapeHtml(s){ return s.replace(/[&<>"']/g, (c)=>({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
function shortId(id){ return (id || '').slice(-6).toUpperCase(); }
function statusLabel(status){
  if(status === 'billed') return 'Billed';
  if(status === 'forwarded') return 'Forwarded to admin';
  return 'Pending';
}
function showToast(msg){
  const root = document.getElementById('toastRoot');
  root.innerHTML = `<div class="toast">${msg}</div>`;
  setTimeout(()=>{ root.innerHTML = ''; }, 2400);
}

// ---- Detail modal (with a tiny back-stack for nested sheets) ----
function pushSheet(renderFn){
  navStack.push(renderFn);
  renderFn();
}
function popSheet(){
  navStack.pop();
  if(navStack.length){ navStack[navStack.length - 1](); }
  else closeModal();
}
function closeModal(){
  navStack = [];
  document.getElementById('modalRoot').innerHTML = '';
}

function openDetail(id){
  navStack = [];
  pushSheet(()=>renderEntrySheet(id));
}

function renderEntrySheet(id){
  const e = billingEntries.find((x)=>x.id === id);
  if(!e) return;
  const p = findPatient(e.patientId);
  const root = document.getElementById('modalRoot');
  root.innerHTML = `
    <div class="overlay" id="overlay">
      <div class="sheet">
        <button class="sheet-close" id="closeSheet">✕</button>
        <h3>MBS ${escapeHtml((e.mbsList || []).join(', '))}</h3>
        <img class="full" src="${p ? p.photoThumb : ''}" alt="Patient label">
        <div class="detail-row"><span class="k">Patient ref</span><span class="v">#${shortId(e.patientId)}</span></div>
        <div class="detail-row"><span class="k">Date</span><span class="v">${formatDate(e.date)}</span></div>
        <div class="detail-row"><span class="k">Location</span><span class="v">${escapeHtml(e.location || '—')}</span></div>
        <div class="detail-row"><span class="k">MBS item(s)</span><span class="v">${escapeHtml((e.mbsList || []).join(', '))}</span></div>
        <div class="detail-row"><span class="k">Note</span><span class="v">${e.note ? escapeHtml(e.note) : '—'}</span></div>
        ${e.forwardedAt ? `<div class="detail-row"><span class="k">Forwarded at</span><span class="v">${new Date(e.forwardedAt).toLocaleString('en-AU')}</span></div>` : ''}
        ${e.billedAt ? `<div class="detail-row"><span class="k">Billed at</span><span class="v">${new Date(e.billedAt).toLocaleString('en-AU')}</span></div>` : ''}

        <label class="field-label">Status</label>
        <select id="statusSelect">
          <option value="pending" ${e.status === 'pending' ? 'selected' : ''}>Pending</option>
          <option value="forwarded" ${e.status === 'forwarded' ? 'selected' : ''}>Forwarded to admin</option>
          <option value="billed" ${e.status === 'billed' ? 'selected' : ''}>Billed</option>
        </select>

        <div class="btn-row">
          <button class="btn btn-primary btn-sm" id="pdfBtn">Generate PDF</button>
          <button class="btn btn-ghost btn-sm" id="historyBtn">View patient history</button>
        </div>
        <div class="btn-row">
          <button class="btn btn-ghost btn-sm" id="addDayBtn">Add another day</button>
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
  document.getElementById('historyBtn').onclick = ()=>pushSheet(()=>renderPatientSheet(e.patientId));
  document.getElementById('addDayBtn').onclick = ()=>addAnotherDayFor(e.patientId);
  const editBtnEl = document.getElementById('editBtn');
  if(editBtnEl) editBtnEl.onclick = ()=>startEdit(e.id);
  document.getElementById('statusSelect').onchange = async (ev)=>{
    const newStatus = ev.target.value;
    e.status = newStatus;
    if(newStatus === 'forwarded'){ e.forwardedAt = new Date(); }
    else { delete e.forwardedAt; }
    if(newStatus === 'billed'){ e.billedAt = new Date(); }
    else { delete e.billedAt; }
    await idbPut('billingEntries', e);
    if(newStatus === 'billed') notifyBilled(e); else showToast(`Marked as ${statusLabel(newStatus).toLowerCase()}`);
    closeModal();
    renderLists();
  };
  document.getElementById('deleteBtn').onclick = async ()=>{
    billingEntries = billingEntries.filter((x)=>x.id !== id);
    selected.delete(id);
    await idbDelete('billingEntries', id);
    closeModal();
    renderLists();
  };
}

function renderPatientSheet(patientId){
  const p = findPatient(patientId);
  if(!p) return;
  const lines = billingEntries
    .filter((e)=>e.patientId === patientId)
    .sort((a, b)=>new Date(b.date) - new Date(a.date));
  const root = document.getElementById('modalRoot');
  root.innerHTML = `
    <div class="overlay" id="overlay">
      <div class="sheet">
        <button class="sheet-close" id="backBtn" aria-label="Back">←</button>
        <h3>Patient #${shortId(p.id)}</h3>
        <img class="full" src="${p.photoFull}" alt="Patient label, full quality backup">
        <div class="btn-row">
          <button class="btn btn-ghost btn-sm" id="ocrBtn">${p.ocrText ? 'Re-detect text' : 'Detect text (beta)'}</button>
          <button class="btn btn-primary btn-sm" id="addDayBtn2">Add another day</button>
        </div>
        ${p.ocrText ? `<p class="mbs-hint" style="margin:10px 0;">Detected (unverified, search-only): "${escapeHtml(p.ocrText.slice(0, 160))}"</p>` : ''}
        <p class="section-title" style="margin-top:16px;">Billing entries for this patient</p>
        <div id="patientLinesList"></div>
      </div>
    </div>`;
  document.getElementById('backBtn').onclick = popSheet;
  document.getElementById('overlay').addEventListener('click', (ev)=>{ if(ev.target.id === 'overlay') closeModal(); });
  document.getElementById('addDayBtn2').onclick = ()=>addAnotherDayFor(p.id);
  document.getElementById('ocrBtn').onclick = ()=>runOcr(p.id);

  const listEl = document.getElementById('patientLinesList');
  if(!lines.length){
    listEl.innerHTML = `<div class="empty">No billing entries yet for this patient.</div>`;
  } else {
    lines.forEach((e)=>{
      const row = document.createElement('div');
      row.className = 'entry';
      row.innerHTML = `
        <div class="entry-body">
          <div class="entry-mbs">MBS ${escapeHtml((e.mbsList || []).join(', '))}</div>
          <div class="entry-meta">${formatDate(e.date)} · ${escapeHtml(e.location || '—')}</div>
        </div>
        <span class="badge badge-${e.status}">${statusLabel(e.status)}</span>
      `;
      row.addEventListener('click', ()=>pushSheet(()=>renderEntrySheet(e.id)));
      listEl.appendChild(row);
    });
  }
}

async function runOcr(patientId){
  const p = findPatient(patientId);
  if(!p) return;
  showToast('Reading label… this can take a few seconds');
  try{
    if(typeof Tesseract === 'undefined'){
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.0.4/tesseract.min.js');
    }
    const result = await Tesseract.recognize(p.photoFull, 'eng');
    p.ocrText = (result && result.data && result.data.text || '').trim();
    await idbPut('patients', p);
    showToast('Text detected');
  }catch(err){
    showToast('Text detection wasn\u2019t available — needs an internet connection the first time');
  }
  pushSheet(()=>renderPatientSheet(patientId));
}

function loadScript(src){
  return new Promise((resolve, reject)=>{
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

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

// ---- Generic "deliver a file" flow (share sheet, with an in-Safari fallback) ----
function deliverFile(blob, fileName, mimeType, title){
  const file = new File([blob], fileName, { type: mimeType });
  const blobUrl = URL.createObjectURL(blob);
  const canShareFile = !!(navigator.canShare && navigator.canShare({ files:[file] }));

  const root = document.getElementById('modalRoot');
  root.innerHTML = `
    <div class="overlay" id="overlay">
      <div class="sheet">
        <button class="sheet-close" id="closeSheet">✕</button>
        <h3>${title || 'File ready'}</h3>
        <p style="font-size:13.5px;color:var(--muted);line-height:1.5;margin:0 0 14px 0;">${fileName}</p>
        <button class="btn btn-primary" id="shareBtn">${canShareFile ? 'Share' : 'Try share (may not be supported here)'}</button>
        <a href="${blobUrl}" target="_blank" rel="noopener" class="btn btn-ghost" id="saveLink" style="display:block;text-align:center;text-decoration:none;">Open a copy in Safari</a>
      </div>
    </div>`;

  document.getElementById('shareBtn').onclick = async ()=>{
    if(!canShareFile){ showToast('Sharing files isn\u2019t available here — try "Open a copy in Safari"'); return; }
    try{ await navigator.share({ files:[file], title }); showToast('Shared'); }
    catch(err){ if(err && err.name !== 'AbortError') showToast('Share didn\u2019t go through — try "Open a copy in Safari"'); }
  };
  document.getElementById('closeSheet').onclick = closeModal;
  document.getElementById('overlay').addEventListener('click', (ev)=>{ if(ev.target.id === 'overlay') closeModal(); });
}

// ---- PDF generation (billing slips) ----
async function generatePdf(list){
  if(!list.length) return;

  const toForward = list.filter((e)=>e.status === 'pending');
  if(toForward.length){
    const now = new Date();
    await Promise.all(toForward.map((e)=>{ e.status = 'forwarded'; e.forwardedAt = now; return idbPut('billingEntries', e); }));
    renderLists();
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:'pt', format:'a4' });

  list.forEach((e, idx)=>{
    const p = findPatient(e.patientId);
    if(idx > 0) doc.addPage();
    doc.setFontSize(16); doc.setTextColor(18, 42, 69);
    doc.text('My Heart Cardiology', 40, 50);
    doc.setFontSize(11); doc.setTextColor(107, 119, 133);
    doc.text('Inpatient Billing Slip', 40, 68);
    doc.setDrawColor(223, 228, 232);
    doc.line(40, 80, 555, 80);

    doc.setFontSize(11); doc.setTextColor(18, 42, 69);
    let y = 108;
    const line = (label, value)=>{
      doc.setTextColor(107, 119, 133); doc.text(label, 40, y);
      doc.setTextColor(18, 42, 69);
      const wrapped = doc.splitTextToSize(String(value || '—'), 375);
      doc.text(wrapped, 180, y);
      y += 22 * wrapped.length;
    };
    line('Clinician:', clinicianName || 'Not set');
    line('Patient ref:', `#${shortId(e.patientId)}`);
    line('Date of service:', formatDate(e.date));
    line('Location:', e.location);
    line('MBS item number(s):', (e.mbsList || []).join(', '));
    line('Note:', e.note);
    line('Status:', statusLabel(e.status));

    y += 14;
    doc.setFontSize(9.5); doc.setTextColor(107, 119, 133);
    doc.text('Patient label (source record):', 40, y);
    y += 10;
    embedPhotoInPdf(doc, p ? p.photoFull : null, 40, y, 515, 620 - y);

    doc.setFontSize(8.5); doc.setTextColor(150, 158, 166);
    doc.text('Generated on this device — no data transmitted externally.', 40, 800);
  });

  const blob = doc.output('blob');
  const fileName = list.length === 1
    ? `MHC-billing-${list[0].date}-${slugify(list[0].location)}-${(list[0].mbsList || []).join('+')}.pdf`
    : `MHC-billing-batch-${new Date().toISOString().slice(0, 10)}.pdf`;
  deliverFile(blob, fileName, 'application/pdf', 'MHC Billing Slip');
}

// ---- Bulk actions ----
document.getElementById('selectAllPending').addEventListener('change', (ev)=>{
  const selectable = activeEntries().filter((e)=>e.status === 'pending' || e.status === 'forwarded');
  if(ev.target.checked) selectable.forEach((e)=>selected.add(e.id));
  else selectable.forEach((e)=>selected.delete(e.id));
  renderLists();
});
document.getElementById('bulkMarkBilledBtn').addEventListener('click', async ()=>{
  const list = activeEntries().filter((e)=>selected.has(e.id) && e.status !== 'billed');
  if(!list.length) return;
  const now = new Date();
  await Promise.all(list.map((e)=>{ e.status = 'billed'; e.billedAt = now; return idbPut('billingEntries', e); }));
  selected.clear();
  showToast(`${list.length} ${list.length === 1 ? 'entry' : 'entries'} marked billed`);
  renderLists();
});
document.getElementById('bulkExportBtn').addEventListener('click', ()=>{
  const list = activeEntries().filter((e)=>selected.has(e.id));
  if(!list.length){ showToast('Select entries to export first'); return; }
  generatePdf(list);
});

// ==========================================================================
// Settings — a single local clinician name, no switching/PIN. Kept simple on
// purpose: without a server, "multiple logins" can't be real authentication,
// so it's not worth the complexity or the risk of implying security it can't provide.
// ==========================================================================
document.getElementById('settingsBtn').addEventListener('click', ()=>{
  navStack = [];
  pushSheet(renderSettingsSheet);
});
function renderSettingsSheet(){
  const root = document.getElementById('modalRoot');
  root.innerHTML = `
    <div class="overlay" id="overlay">
      <div class="sheet">
        <button class="sheet-close" id="closeSheet">✕</button>
        <h3>Settings</h3>
        <label class="field-label first">Clinician name</label>
        <input type="text" id="clinicianInput" placeholder="Dr First Last" value="${clinicianName ? escapeHtml(clinicianName) : ''}">
        <div class="settings-row"><span style="font-size:13px;color:var(--muted);">Appears on generated PDF slips and reports</span></div>
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
}

// ==========================================================================
// Reports (CSV / XLSX / PDF audit export)
// ==========================================================================
document.getElementById('reportsBtn').addEventListener('click', ()=>{
  navStack = [];
  pushSheet(renderReportsSheet);
});

function renderReportsSheet(){
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const root = document.getElementById('modalRoot');
  root.innerHTML = `
    <div class="overlay" id="overlay">
      <div class="sheet">
        <button class="sheet-close" id="closeSheet">✕</button>
        <h3>Export report</h3>
        <p class="mbs-hint" style="margin:0 0 14px 0;">Exports reference each patient by ID only (e.g. #A1B2C3) — no names are included. The PDF includes each patient's label photo as an appendix; CSV/Excel are data-only, so use "Export photos" alongside them if you need the images too.</p>
        <label class="field-label first">From</label>
        <input type="date" id="reportFrom" value="${monthAgo}">
        <label class="field-label">To</label>
        <input type="date" id="reportTo" value="${today}">
        <label class="field-label">Status</label>
        <select id="reportStatus">
          <option value="all">All</option>
          <option value="pending">Pending only</option>
          <option value="forwarded">Forwarded to admin only</option>
          <option value="billed">Billed only</option>
        </select>
        <div class="btn-row">
          <button class="btn btn-primary btn-sm" id="exportCsvBtn">Export CSV</button>
          <button class="btn btn-primary btn-sm" id="exportXlsxBtn">Export Excel</button>
        </div>
        <div class="btn-row">
          <button class="btn btn-ghost btn-sm" id="exportPdfBtn">Export PDF (with photos)</button>
        </div>
        <div class="btn-row">
          <button class="btn btn-ghost btn-sm" id="exportPhotosBtn">Export photos (ZIP)</button>
        </div>
      </div>
    </div>`;
  document.getElementById('closeSheet').onclick = closeModal;
  document.getElementById('overlay').addEventListener('click', (ev)=>{ if(ev.target.id === 'overlay') closeModal(); });
  document.getElementById('exportCsvBtn').onclick = ()=>exportReport('csv');
  document.getElementById('exportXlsxBtn').onclick = ()=>exportReport('xlsx');
  document.getElementById('exportPdfBtn').onclick = ()=>exportReport('pdf');
  document.getElementById('exportPhotosBtn').onclick = ()=>exportReport('photos');
}

function reportRows(){
  const from = document.getElementById('reportFrom').value;
  const to = document.getElementById('reportTo').value;
  const status = document.getElementById('reportStatus').value;
  return activeEntries()
    .filter((e)=>(!from || e.date >= from) && (!to || e.date <= to) && (status === 'all' || e.status === status))
    .sort((a, b)=>a.date.localeCompare(b.date))
    .map((e)=>({
      date: e.date,
      location: e.location || '',
      patientId: e.patientId,
      patientRef: `#${shortId(e.patientId)}`,
      mbs: (e.mbsList || []).join(', '),
      note: e.note || '',
      status: statusLabel(e.status),
      billedAt: e.billedAt ? new Date(e.billedAt).toLocaleString('en-AU') : '',
      clinician: clinicianName || 'Not set'
    }));
}

// Shared photo-embedding logic used by both the billing-slip PDF and the report appendix,
// so the two stay consistent rather than drifting apart.
function embedPhotoInPdf(doc, photoDataUrl, x, y, maxW, maxH){
  try{
    if(!photoDataUrl) throw new Error('no photo');
    const fmtMatch = /^data:image\/(jpeg|jpg|png|webp);/i.exec(photoDataUrl);
    const rawFmt = fmtMatch ? fmtMatch[1].toUpperCase() : 'JPEG';
    const fmt = rawFmt === 'JPG' ? 'JPEG' : rawFmt;
    const imgProps = doc.getImageProperties(photoDataUrl);
    let w = maxW, h = (imgProps.height / imgProps.width) * maxW;
    if(h > maxH){ h = maxH; w = (imgProps.width / imgProps.height) * maxH; }
    doc.addImage(photoDataUrl, fmt, x, y, w, h, undefined, 'NONE');
    return h;
  }catch(err){
    doc.setTextColor(179, 58, 49);
    doc.text('Photo could not be embedded.', x, y + 14);
    return 20;
  }
}

async function exportReport(kind){
  const rows = reportRows();
  if(!rows.length){ showToast('No entries match that filter'); return; }
  const stamp = new Date().toISOString().slice(0, 10);

  if(kind === 'csv'){
    const headers = ['Date','Location','Patient Ref','MBS Item(s)','Note','Status','Billed At','Clinician'];
    const escapeCsv = (v)=>`"${String(v).replace(/"/g, '""')}"`;
    const lines = [headers.map(escapeCsv).join(',')]
      .concat(rows.map((r)=>[r.date, r.location, r.patientRef, r.mbs, r.note, r.status, r.billedAt, r.clinician].map(escapeCsv).join(',')));
    const blob = new Blob([lines.join('\r\n')], { type:'text/csv' });
    deliverFile(blob, `MHC-billing-report-${stamp}.csv`, 'text/csv', 'Billing report (CSV)');
    return;
  }

  if(kind === 'xlsx'){
    try{
      if(typeof XLSX === 'undefined'){
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
      }
      const ws = XLSX.utils.json_to_sheet(rows.map((r)=>({
        Date:r.date, Location:r.location, 'Patient Ref':r.patientRef, 'MBS Item(s)':r.mbs,
        Note:r.note, Status:r.status, 'Billed At':r.billedAt, Clinician:r.clinician
      })));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Billing');
      const wbout = XLSX.write(wb, { bookType:'xlsx', type:'array' });
      const blob = new Blob([wbout], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      deliverFile(blob, `MHC-billing-report-${stamp}.xlsx`, blob.type, 'Billing report (Excel)');
    }catch(err){
      showToast('Excel export needs an internet connection the first time it\u2019s used');
    }
    return;
  }

  if(kind === 'pdf'){
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit:'pt', format:'a4', orientation:'landscape' });
    doc.setFontSize(14); doc.setTextColor(18, 42, 69);
    doc.text('My Heart Cardiology — Billing Report', 30, 30);
    doc.setFontSize(9); doc.setTextColor(107, 119, 133);
    doc.text(`Clinician: ${clinicianName || 'Not set'}  ·  Generated ${new Date().toLocaleString('en-AU')}`, 30, 46);

    const headers = ['Date','Location','Patient Ref','MBS Item(s)','Note','Status','Billed At'];
    const colX = [30, 90, 200, 260, 380, 500, 560];
    let y = 70;
    doc.setFontSize(8.5); doc.setTextColor(255,255,255);
    doc.setFillColor(18, 42, 69);
    doc.rect(30, y - 12, 770, 16, 'F');
    headers.forEach((h, i)=>doc.text(h, colX[i], y));
    y += 16;
    doc.setTextColor(30, 30, 30);
    rows.forEach((r, i)=>{
      if(y > 560){ doc.addPage(); y = 40; }
      if(i % 2 === 0){ doc.setFillColor(245, 247, 248); doc.rect(30, y - 11, 770, 15, 'F'); }
      const vals = [r.date, r.location, r.patientRef, r.mbs, r.note, r.status, r.billedAt];
      vals.forEach((v, j)=>doc.text(String(v || '—').slice(0, 40), colX[j], y));
      y += 15;
    });

    // Photo appendix — one page per unique patient in this report, portrait, for legibility
    const uniquePatientIds = [...new Set(rows.map((r)=>r.patientId))];
    uniquePatientIds.forEach((pid, idx)=>{
      const p = findPatient(pid);
      doc.addPage('a4', 'portrait');
      doc.setFontSize(13); doc.setTextColor(18, 42, 69);
      doc.text(`Appendix ${idx + 1} of ${uniquePatientIds.length} — Patient #${shortId(pid)}`, 40, 40);
      doc.setFontSize(9); doc.setTextColor(107, 119, 133);
      const datesForPatient = rows.filter((r)=>r.patientId === pid).map((r)=>r.date).join(', ');
      doc.text(`Billing dates in this report: ${datesForPatient}`, 40, 58);
      embedPhotoInPdf(doc, p ? p.photoFull : null, 40, 75, 515, 680);
    });

    const blob = doc.output('blob');
    deliverFile(blob, `MHC-billing-report-${stamp}.pdf`, 'application/pdf', 'Billing report (PDF, with photo appendix)');
    return;
  }

  if(kind === 'photos'){
    try{
      if(typeof JSZip === 'undefined'){
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
      }
      const zip = new JSZip();
      const uniquePatientIds = [...new Set(rows.map((r)=>r.patientId))];
      uniquePatientIds.forEach((pid)=>{
        const p = findPatient(pid);
        if(!p || !p.photoFull) return;
        const base64 = p.photoFull.split(',')[1];
        zip.file(`patient-${shortId(pid)}.jpg`, base64, { base64:true });
      });
      const blob = await zip.generateAsync({ type:'blob' });
      deliverFile(blob, `MHC-billing-photos-${stamp}.zip`, 'application/zip', 'Patient label photos (ZIP)');
    }catch(err){
      showToast('Photo export needs an internet connection the first time it\u2019s used');
    }
  }
}

// ==========================================================================
// Boot — load everything, migrate legacy data if present
// ==========================================================================
async function migrateLegacyIfNeeded(){
  const [legacyEntries, existingPatients, existingBilling] = await Promise.all([
    idbAll('entries'), idbAll('patients'), idbAll('billingEntries')
  ]);
  if(!legacyEntries.length || existingPatients.length || existingBilling.length) return;

  for(const old of legacyEntries){
    const patient = {
      id: genId('pt'),
      photoThumb: old.photo, photoFull: old.photo, ocrText: '', createdAt: old.createdAt || new Date()
    };
    await idbPut('patients', patient);
    const billing = {
      id: old.id, patientId: patient.id,
      date: old.date, location: old.location, mbsList: old.mbsList || [], note: old.note || '',
      status: old.status || 'pending', billedAt: old.billedAt, createdAt: old.createdAt || new Date()
    };
    await idbPut('billingEntries', billing);
  }
}

// Anyone who used the short-lived multi-practitioner beta gets their active
// practitioner's name carried forward as the single clinician name, so nothing
// is silently lost when that feature is removed.
async function migrateNameFromOldMultiLoginIfNeeded(){
  const already = await idbGetSetting('clinicianName');
  if(already) return already;
  try{
    const [prList, activeId] = await Promise.all([idbAll('practitioners'), idbGetSetting('activePractitionerId')]);
    const chosen = prList.find((p)=>p.id === activeId) || prList[0];
    if(chosen && chosen.name){
      await idbSetSetting('clinicianName', chosen.name);
      return chosen.name;
    }
  }catch(err){ /* no legacy practitioner data present — nothing to carry forward */ }
  return '';
}

async function init(){
  try{
    await migrateLegacyIfNeeded();
    clinicianName = await migrateNameFromOldMultiLoginIfNeeded();
    [patients, billingEntries] = await Promise.all([idbAll('patients'), idbAll('billingEntries')]);
    billingEntries.sort((a, b)=>new Date(b.createdAt) - new Date(a.createdAt));
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
