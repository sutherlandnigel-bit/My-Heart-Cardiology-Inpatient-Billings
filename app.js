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

// Binds an event listener only if the element actually exists. Used for every
// top-level (script-load-time) binding, so that one missing/renamed element — e.g.
// from a partially-applied deploy or a stale cached HTML file — can't throw and
// halt the rest of the script (which would otherwise stop init() from ever running).
function on(id, event, handler){
  const el = document.getElementById(id);
  if(el) el.addEventListener(event, handler);
  else console.warn(`MHC Billing: expected element #${id} was not found — app.js and index.html may be out of sync. Try a hard refresh.`);
}

// ==========================================================================
// App state
// ==========================================================================
let clinicianName = '';
let mbsFavorites = []; // user's own curated {code, descriptor} list — never pre-populated by the app itself
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

// ---- Patient status (discharged/current) + follow-up instructions, right in the entry form ----
on('patientStatusInput', 'change', (ev)=>{
  const field = document.getElementById('dischargeDateField');
  if(!field) return;
  if(ev.target.value === 'discharged'){
    field.style.display = 'block';
    const dateEl = document.getElementById('dischargeDateEntryInput');
    if(dateEl && !dateEl.value) dateEl.value = new Date().toISOString().slice(0, 10);
  } else {
    field.style.display = 'none';
  }
});

// Fills the form's status/follow-up fields from a patient record (or clears them for a brand-new patient).
function populatePatientStatusFields(p){
  const statusEl = document.getElementById('patientStatusInput');
  const dateField = document.getElementById('dischargeDateField');
  const dateEl = document.getElementById('dischargeDateEntryInput');
  const followUpEl = document.getElementById('followUpEntryInput');
  if(!statusEl || !dateField || !dateEl || !followUpEl) return;

  if(p && p.dischargedAt){
    statusEl.value = 'discharged';
    dateField.style.display = 'block';
    dateEl.value = p.dischargedAt;
  } else {
    statusEl.value = 'current';
    dateField.style.display = 'none';
    dateEl.value = '';
  }
  followUpEl.value = (p && p.followUpInstructions) ? p.followUpInstructions : '';
}

// Applies whatever the form's status/follow-up fields currently say back onto a patient record.
async function applyPatientStatusFields(p){
  const statusEl = document.getElementById('patientStatusInput');
  const dateEl = document.getElementById('dischargeDateEntryInput');
  const followUpEl = document.getElementById('followUpEntryInput');
  if(!statusEl || !dateEl || !followUpEl) return;

  if(statusEl.value === 'discharged'){
    p.dischargedAt = dateEl.value || new Date().toISOString().slice(0, 10);
  } else {
    p.dischargedAt = null;
  }
  p.followUpInstructions = followUpEl.value.trim();
  await idbPut('patients', p);
}

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
on('addMbsRowBtn', 'click', ()=>{
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

// ---- MBS favorites picker — a curated list the clinician builds themselves in
// Settings. The app never pre-populates or invents MBS codes/descriptors. ----
function addMbsCodeToForm(code){
  const inputs = Array.from(document.querySelectorAll('.mbs-row-input'));
  const emptyInput = inputs.find((i)=>!i.value.trim());
  if(emptyInput){
    emptyInput.value = code;
  } else {
    const row = document.createElement('div');
    row.className = 'mbs-row';
    row.innerHTML = `<input type="text" class="mbs-row-input" placeholder="e.g. 55126" inputmode="numeric" value="${escapeHtml(code)}">`;
    document.getElementById('mbsRows').appendChild(row);
  }
  refreshMbsRemoveButtons();
}
function openMbsPicker(){
  if(!mbsFavorites.length){ showToast('No saved items yet — add some in Settings'); return; }
  navStack = [];
  pushSheet(renderMbsPickerSheet);
}
function renderMbsPickerSheet(){
  const root = document.getElementById('modalRoot');
  root.innerHTML = `
    <div class="overlay" id="overlay">
      <div class="sheet">
        <button class="sheet-close" id="closeSheet">✕</button>
        <h3>Pick an item</h3>
        <div id="mbsPickerList"></div>
      </div>
    </div>`;
  document.getElementById('closeSheet').onclick = closeModal;
  document.getElementById('overlay').addEventListener('click', (ev)=>{ if(ev.target.id === 'overlay') closeModal(); });
  const listEl = document.getElementById('mbsPickerList');
  mbsFavorites.forEach((f)=>{
    const row = document.createElement('div');
    row.className = 'picker-row';
    row.innerHTML = `
      <div class="picker-row-body">
        <div class="picker-row-label">${escapeHtml(f.code)}</div>
        <div class="picker-row-meta">${escapeHtml(f.descriptor || '')}</div>
      </div>`;
    row.addEventListener('click', ()=>{ addMbsCodeToForm(f.code); closeModal(); });
    listEl.appendChild(row);
  });
}
on('pickMbsBtn', 'click', openMbsPicker);

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
    .filter((p)=>!p.dischargedAt)
    .slice()
    .sort((a, b)=>new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 8);

  let chipsHtml = '';
  if(!selectedPatientId && !currentPhoto){
    if(recent.length){
      chipsHtml = `
        <div class="chip-label-row">
          <span class="chip-label">Same patient as a recent entry?</span>
          <button type="button" class="browse-all-link" id="browseAllPatientsBtn">Browse all</button>
        </div>
        <div class="chip-row" id="recentPatientChips">
          ${recent.map((p)=>`
            <div class="patient-chip-wrap">
              <button type="button" class="patient-chip" data-id="${p.id}">
                <img src="${p.photoThumb}" alt="">
              </button>
              <div class="patient-chip-cap">${escapeHtml(patientDisplayName(p))}</div>
            </div>`).join('')}
        </div>`;
    } else if(activePatients().length){
      chipsHtml = `
        <div class="chip-label-row">
          <span class="chip-label">Seen this patient before?</span>
          <button type="button" class="browse-all-link" id="browseAllPatientsBtn">Browse all patients</button>
        </div>`;
    }
  }

  if(selectedPatientId){
    const p = findPatient(selectedPatientId);
    zone.innerHTML = `
      ${chipsHtml}
      <div class="photo-preview">
        <img src="${p ? p.photoThumb : ''}" alt="Selected patient label">
        <button class="retake-btn" id="retakeBtn">Use different patient</button>
      </div>
      <div class="mbs-hint">Using ${p ? escapeHtml(patientDisplayName(p)) : 'an existing patient'}'s photo — only date and item number(s) needed below.</div>`;
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
      <div class="photo-target">
        <div class="sub-top">Stored on this device only</div>
        <div class="photo-source-row">
          <button type="button" class="photo-source-btn" id="takePhotoBtn">
            <span class="glyph">📷</span>
            <span class="hint">Take photo</span>
          </button>
          <button type="button" class="photo-source-btn" id="choosePhotoBtn">
            <span class="glyph">🖼️</span>
            <span class="hint">Choose from library</span>
          </button>
        </div>
      </div>`;
    document.getElementById('takePhotoBtn').onclick = openCameraCapture;
    document.getElementById('choosePhotoBtn').onclick = ()=>document.getElementById('photoInput').click();
  }

  const chipRow = document.getElementById('recentPatientChips');
  if(chipRow){
    chipRow.querySelectorAll('.patient-chip').forEach((btn)=>{
      btn.addEventListener('click', ()=>{
        selectedPatientId = btn.getAttribute('data-id');
        currentPhoto = null;
        setEncounterTypeField('inpatient_review');
        populatePatientStatusFields(findPatient(selectedPatientId));
        renderPhotoZone();
      });
    });
  }
  const browseBtn = document.getElementById('browseAllPatientsBtn');
  if(browseBtn) browseBtn.onclick = openPatientPicker;

  const labelField = document.getElementById('patientLabelField');
  if(labelField) labelField.style.display = (!selectedPatientId) ? 'block' : 'none';
}
renderPhotoZone();

function patientDisplayName(p){
  if(!p) return 'Unknown patient';
  return p.label ? p.label : `Patient #${shortId(p.id)}`;
}
function patientLastEntry(patientId){
  const lines = billingEntries.filter((e)=>e.patientId === patientId);
  if(!lines.length) return null;
  return lines.reduce((a, b)=>(a.date > b.date ? a : b));
}

async function processPhotoDataUrl(dataUrl){
  const [full, thumb] = await Promise.all([
    downscaleImage(dataUrl, 1600, 0.88),
    downscaleImage(dataUrl, 480, 0.75)
  ]);
  currentPhoto = { full, thumb };
  selectedPatientId = null;
  renderPhotoZone();
}

function handlePhotoFile(file){
  if(!file) return;
  const reader = new FileReader();
  reader.onload = ()=>processPhotoDataUrl(reader.result);
  reader.readAsDataURL(file);
}
on('photoInput', 'change', (e)=>handlePhotoFile(e.target.files[0]));
on('photoInputCamera', 'change', (e)=>handlePhotoFile(e.target.files[0]));

// ==========================================================================
// In-page camera capture — a live camera view rendered directly in the app
// (getUserMedia), rather than handing off to the phone's separate camera app.
// Falls back to the OS camera picker if getUserMedia isn't supported.
// ==========================================================================
let cameraStream = null;

async function openCameraCapture(){
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    document.getElementById('photoInputCamera').click(); // fallback for unsupported browsers
    return;
  }
  renderCameraLive();
  try{
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } }, audio: false
    });
    const video = document.getElementById('cameraVideo');
    if(video){ video.srcObject = cameraStream; await video.play().catch(()=>{}); }
  }catch(err){
    renderCameraError();
  }
}

function stopCameraStream(){
  if(cameraStream){
    cameraStream.getTracks().forEach((t)=>t.stop());
    cameraStream = null;
  }
}

function closeCameraCapture(){
  stopCameraStream();
  document.getElementById('cameraRoot').innerHTML = '';
}

function renderCameraLive(){
  const root = document.getElementById('cameraRoot');
  root.innerHTML = `
    <div class="camera-overlay">
      <video id="cameraVideo" class="camera-video" autoplay playsinline muted></video>
      <div class="camera-top-bar">
        <button class="camera-close-btn" id="cameraCloseBtn" aria-label="Cancel">✕</button>
      </div>
      <div class="camera-controls">
        <button class="shutter-btn" id="shutterBtn" aria-label="Take photo"></button>
      </div>
    </div>`;
  document.getElementById('cameraCloseBtn').onclick = closeCameraCapture;
  document.getElementById('shutterBtn').onclick = captureFrame;
}

function renderCameraError(){
  const root = document.getElementById('cameraRoot');
  root.innerHTML = `
    <div class="camera-overlay">
      <div class="camera-top-bar">
        <button class="camera-close-btn" id="cameraCloseBtn" aria-label="Close">✕</button>
      </div>
      <div class="camera-error">
        <p>Couldn't access the camera — check camera permission for this app in your phone's settings, or use "Choose from library" instead.</p>
        <button class="btn btn-ghost" id="cameraErrorCloseBtn">Close</button>
      </div>
    </div>`;
  document.getElementById('cameraCloseBtn').onclick = closeCameraCapture;
  document.getElementById('cameraErrorCloseBtn').onclick = closeCameraCapture;
}

function captureFrame(){
  const video = document.getElementById('cameraVideo');
  if(!video || !video.videoWidth) return;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  renderCameraReview(dataUrl);
}

function renderCameraReview(dataUrl){
  const root = document.getElementById('cameraRoot');
  root.innerHTML = `
    <div class="camera-overlay">
      <img class="camera-preview-img" src="${dataUrl}" alt="Captured photo preview">
      <div class="camera-top-bar">
        <button class="camera-close-btn" id="cameraCloseBtn" aria-label="Cancel">✕</button>
      </div>
      <div class="camera-review-controls">
        <button class="btn btn-ghost" id="retakeFrameBtn">Retake</button>
        <button class="btn btn-primary" id="usePhotoBtn">Use this photo</button>
      </div>
    </div>`;
  document.getElementById('cameraCloseBtn').onclick = closeCameraCapture;
  document.getElementById('retakeFrameBtn').onclick = renderCameraLive;
  document.getElementById('usePhotoBtn').onclick = async ()=>{
    await processPhotoDataUrl(dataUrl);
    closeCameraCapture();
  };
}


// ---- Save / update a billing entry ----
on('saveBtn', 'click', async ()=>{
  const err = document.getElementById('formErr');
  const mbsList = collectMbsValues();
  const date = dateInput.value;
  const location = document.getElementById('locationInput').value;
  const note = document.getElementById('noteInput').value.trim();
  const encounterTypeEl = document.getElementById('encounterTypeInput');
  const encounterType = encounterTypeEl ? encounterTypeEl.value : 'inpatient_review';

  if(!selectedPatientId && !currentPhoto){ err.textContent = 'Add a photo, or pick an existing patient above.'; return; }
  if(!date){ err.textContent = 'Select a date.'; return; }
  if(!location){ err.textContent = 'Select a location.'; return; }
  if(!mbsList.length){ err.textContent = 'Enter at least one MBS item number.'; return; }
  err.textContent = '';

  // Same-day duplicate check — only meaningful when reusing an existing patient,
  // since a brand-new patient can't already have an entry today by definition.
  if(editingId === null && selectedPatientId){
    const dup = billingEntries.some((e)=>e.patientId === selectedPatientId && e.date === date);
    if(dup){
      const p = findPatient(selectedPatientId);
      const proceed = await confirmDialog(
        `${escapeHtml(patientDisplayName(p))} already has a billing entry for ${formatDate(date)}. Save this as an additional entry anyway?`,
        'Save anyway'
      );
      if(!proceed) return;
    }
  }

  try{
    if(editingId !== null){
      const e = billingEntries.find((x)=>x.id === editingId);
      if(e){
        e.date = date; e.location = location; e.mbsList = mbsList; e.note = note; e.encounterType = encounterType;
        await idbPut('billingEntries', e);
        const p = findPatient(e.patientId);
        if(p) await applyPatientStatusFields(p);
      }
      showToast('Entry updated');
      editingId = null;
    } else {
      let patientId = selectedPatientId;
      let patient;
      if(!patientId){
        patient = {
          id: genId('pt'),
          photoThumb: currentPhoto.thumb, photoFull: currentPhoto.full,
          label: document.getElementById('patientLabelInput').value.trim(),
          ocrText: '', createdAt: new Date()
        };
        patients.unshift(patient);
        patientId = patient.id;
      } else {
        patient = findPatient(patientId);
      }
      if(patient) await applyPatientStatusFields(patient);
      const now = new Date();
      const entry = {
        id: genId('bl'), patientId,
        date, location, mbsList, note, encounterType, status:'pending', createdAt: now,
        statusHistory: [{ status:'pending', at: now }]
      };
      billingEntries.unshift(entry);
      await idbPut('billingEntries', entry);
      showToast('Entry saved');
    }
  } catch(saveErr){
    err.textContent = 'Could not save to device storage — try again.';
    return;
  }

  // The entry is already safely persisted above at this point — anything below is just
  // refreshing what's on screen, so a hiccup here should never be mistaken for a failed save.
  try{
    resetForm();
    renderLists();
  }catch(renderErr){
    showToast('Saved — refresh the page if the list looks out of date');
  }
});

on('cancelEditBtn', 'click', ()=>{
  editingId = null;
  resetForm();
});

function resetForm(){
  currentPhoto = null;
  selectedPatientId = null;
  renderPhotoZone();
  renderMbsRows(['']);
  document.getElementById('patientLabelInput').value = '';
  document.getElementById('noteInput').value = '';
  document.getElementById('locationInput').value = '';
  setEncounterTypeField('inpatient_new');
  populatePatientStatusFields(null);
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
  setEncounterTypeField(e.encounterType || 'inpatient_review');
  populatePatientStatusFields(findPatient(e.patientId));
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
  setEncounterTypeField('inpatient_review');
  populatePatientStatusFields(findPatient(patientId));
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
  renderMissedBillingBanner();
}

// ---- Missed-billing gap detection ----
// Heuristic only: flags a patient if 2+ calendar days have passed since their most
// recent billing entry, unless that entry was marked "Discharge" (episode ended).
// Doesn't know about planned leave, weekends, etc. — a prompt to check, not a verdict.
function computeMissedBillingAlerts(){
  const todayStr = new Date().toISOString().slice(0, 10);
  const alerts = [];
  activePatients().forEach((p)=>{
    if(p.dischargedAt) return; // explicitly discharged — no further billing expected
    const lines = billingEntries
      .filter((e)=>e.patientId === p.id && typeof e.date === 'string' && e.date)
      .sort((a, b)=>a.date.localeCompare(b.date));
    if(!lines.length) return;
    const last = lines[lines.length - 1];
    if(last.encounterType === 'discharge') return;
    const lastTime = new Date(last.date + 'T00:00:00').getTime();
    if(Number.isNaN(lastTime)) return; // malformed date on this entry — skip rather than crash
    const daysSince = Math.round((new Date(todayStr).getTime() - lastTime) / 86400000);
    if(daysSince >= 2) alerts.push({ patient:p, last, daysSince });
  });
  return alerts.sort((a, b)=>b.daysSince - a.daysSince);
}

function renderMissedBillingBanner(){
  const container = document.getElementById('missedBillingBanner');
  if(!container) return;
  try{
    const alerts = computeMissedBillingAlerts();
    if(!alerts.length){ container.innerHTML = ''; return; }
    container.innerHTML = `
      <div class="alert-banner" id="missedBillingBannerClick">
        <span>⚠️</span>
        <div>
          <strong>Possible missed billing.</strong> ${alerts.length} patient${alerts.length === 1 ? '' : 's'} with no entry recorded in 2+ days. Tap to review.
        </div>
      </div>`;
    document.getElementById('missedBillingBannerClick').onclick = openMissedBillingSheet;
  }catch(err){
    // Never let this optional banner break the rest of the app — worst case, it just doesn't show.
    container.innerHTML = '';
  }
}

function openMissedBillingSheet(){
  navStack = [];
  pushSheet(renderMissedBillingSheet);
}
function renderMissedBillingSheet(){
  const alerts = computeMissedBillingAlerts();
  const root = document.getElementById('modalRoot');
  root.innerHTML = `
    <div class="overlay" id="overlay">
      <div class="sheet">
        <button class="sheet-close" id="closeSheet">✕</button>
        <h3>Possible missed billing</h3>
        <p class="mbs-hint" style="margin:0 0 12px 0;">A simple heuristic — flags patients with no billing entry in 2+ days who haven't been marked Discharge. Doesn't know about planned leave or transfers, so use judgement.</p>
        <div id="missedBillingList"></div>
      </div>
    </div>`;
  document.getElementById('closeSheet').onclick = closeModal;
  document.getElementById('overlay').addEventListener('click', (ev)=>{ if(ev.target.id === 'overlay') closeModal(); });

  const listEl = document.getElementById('missedBillingList');
  if(!alerts.length){
    listEl.innerHTML = `<div class="empty">No gaps detected right now.</div>`;
    return;
  }
  alerts.forEach(({ patient, last, daysSince })=>{
    const row = document.createElement('div');
    row.className = 'picker-row';
    row.innerHTML = `
      <img src="${patient.photoThumb}" alt="">
      <div class="picker-row-body">
        <div class="picker-row-label">${escapeHtml(patientDisplayName(patient))}</div>
        <div class="picker-row-meta">Last billed ${formatDate(last.date)} · ${escapeHtml(last.location || '—')} · ${daysSince} days ago</div>
      </div>
    `;
    row.addEventListener('click', ()=>addAnotherDayFor(patient.id));
    listEl.appendChild(row);
  });
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
      <div class="entry-mbs">${p && p.label ? escapeHtml(p.label) + ' · ' : ''}MBS ${escapeHtml((e.mbsList || []).join(', '))}</div>
      <div class="entry-meta"><span class="encounter-tag">${encounterTypeLabel(e.encounterType)}</span>${formatDate(e.date)} · ${escapeHtml(e.location || '—')}${e.note ? ' · ' + escapeHtml(e.note) : ''}</div>
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
function encounterTypeLabel(type){
  const map = {
    inpatient_new:'Inpatient New', inpatient_review:'Inpatient Review', procedure:'Procedure',
    // legacy values from before this update, mapped to the closest current equivalent
    initial:'Inpatient New', subsequent:'Inpatient Review', review:'Inpatient Review', discharge:'Inpatient Review'
  };
  return map[type] || 'Inpatient Review';
}
function setEncounterTypeField(value){
  const el = document.getElementById('encounterTypeInput');
  if(el) el.value = value;
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

// A confirm dialog that resolves true/false, for interrupting a flow (e.g. same-day
// duplicate warning) without a full page-navigation-style sheet.
function confirmDialog(message, confirmLabel){
  return new Promise((resolve)=>{
    const root = document.getElementById('modalRoot');
    root.innerHTML = `
      <div class="overlay" id="overlay">
        <div class="sheet">
          <h3>Heads up</h3>
          <p style="font-size:14px;color:var(--navy-soft);line-height:1.5;margin:0 0 4px 0;">${message}</p>
          <div class="btn-row">
            <button class="btn btn-ghost btn-sm" id="cancelConfirmBtn">Cancel</button>
            <button class="btn btn-primary btn-sm" id="okConfirmBtn">${confirmLabel || 'Continue'}</button>
          </div>
        </div>
      </div>`;
    document.getElementById('cancelConfirmBtn').onclick = ()=>{ root.innerHTML = ''; resolve(false); };
    document.getElementById('okConfirmBtn').onclick = ()=>{ root.innerHTML = ''; resolve(true); };
  });
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
        <h3>${p && p.label ? escapeHtml(p.label) + ' — ' : ''}MBS ${escapeHtml((e.mbsList || []).join(', '))}</h3>
        <img class="full" src="${p ? p.photoThumb : ''}" alt="Patient label">
        <div class="detail-row"><span class="k">Patient ref</span><span class="v">#${shortId(e.patientId)}</span></div>
        <div class="detail-row"><span class="k">Encounter type</span><span class="v">${encounterTypeLabel(e.encounterType)}</span></div>
        <div class="detail-row"><span class="k">Date</span><span class="v">${formatDate(e.date)}</span></div>
        <div class="detail-row"><span class="k">Location</span><span class="v">${escapeHtml(e.location || '—')}</span></div>
        <div class="detail-row"><span class="k">MBS item(s)</span><span class="v">${escapeHtml((e.mbsList || []).join(', '))}</span></div>
        <div class="detail-row"><span class="k">Note</span><span class="v">${e.note ? escapeHtml(e.note) : '—'}</span></div>

        <label class="field-label">Status</label>
        <select id="statusSelect">
          <option value="pending" ${e.status === 'pending' ? 'selected' : ''}>Pending</option>
          <option value="forwarded" ${e.status === 'forwarded' ? 'selected' : ''}>Forwarded to admin</option>
          <option value="billed" ${e.status === 'billed' ? 'selected' : ''}>Billed</option>
        </select>

        ${(e.statusHistory && e.statusHistory.length) ? `
        <p class="section-title" style="margin-top:14px;">Status history</p>
        ${e.statusHistory.map((h)=>`<div class="detail-row"><span class="k">${statusLabel(h.status)}</span><span class="v">${new Date(h.at).toLocaleString('en-AU')}</span></div>`).join('')}
        ` : ''}

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
    if(!e.statusHistory) e.statusHistory = [];
    e.statusHistory.push({ status: newStatus, at: new Date() });
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
    .sort((a, b)=>a.date.localeCompare(b.date)); // chronological, for a readable timeline
  const today = new Date().toISOString().slice(0, 10);
  const root = document.getElementById('modalRoot');
  root.innerHTML = `
    <div class="overlay" id="overlay">
      <div class="sheet">
        <button class="sheet-close" id="backBtn" aria-label="Back">←</button>
        <h3>${escapeHtml(patientDisplayName(p))}${p.dischargedAt ? '<span class="discharged-tag">Discharged</span>' : ''}</h3>
        <p class="mbs-hint" style="margin:-8px 0 12px 0;">Patient #${shortId(p.id)}</p>
        <img class="full" src="${p.photoFull}" alt="Patient label, full quality backup">
        <label class="field-label first">Your own shorthand for this patient</label>
        <input type="text" id="patientLabelEditInput" placeholder="e.g. Bed 4, or JB" maxlength="40" value="${p.label ? escapeHtml(p.label) : ''}">
        <button class="btn btn-ghost btn-sm" id="saveLabelBtn" style="margin-top:8px;">Save shorthand</button>
        <div class="btn-row">
          <button class="btn btn-ghost btn-sm" id="ocrBtn">${p.ocrText ? 'Re-detect text' : 'Detect text (beta)'}</button>
          <button class="btn btn-primary btn-sm" id="addDayBtn2">Add another day</button>
        </div>
        ${p.ocrText ? `<p class="mbs-hint" style="margin:10px 0;">Detected (unverified, search-only): "${escapeHtml(p.ocrText.slice(0, 160))}"</p>` : ''}

        <p class="section-title" style="margin-top:18px;">Follow-up instructions</p>
        <p class="mbs-hint" style="margin:0 0 8px 0;">Not tied to discharge — useful for any patient, e.g. "repeat troponin tomorrow" or "GP review post-discharge."</p>
        <input type="text" id="followUpInput" placeholder="e.g. GP review in 1 week, repeat echo in 3 months" value="${p.followUpInstructions ? escapeHtml(p.followUpInstructions) : ''}">
        <button class="btn btn-ghost btn-sm" id="saveFollowUpBtn" style="margin-top:8px;">Save follow-up instructions</button>

        <p class="section-title" style="margin-top:18px;">Discharge</p>
        ${p.dischargedAt ? `
          <div class="detail-row"><span class="k">Discharged</span><span class="v">${formatDate(p.dischargedAt)}</span></div>
          <button class="btn btn-ghost btn-sm" id="undischargeBtn" style="margin-top:8px;">Undo discharge</button>
        ` : `
          <label class="field-label first">Discharge date</label>
          <input type="date" id="dischargeDateInput" value="${today}">
          <button class="btn btn-primary btn-sm" id="markDischargedBtn" style="margin-top:8px;">Mark as discharged</button>
        `}

        <p class="section-title" style="margin-top:18px;">Episode timeline</p>
        <div id="patientLinesList"></div>
      </div>
    </div>`;
  document.getElementById('backBtn').onclick = popSheet;
  document.getElementById('overlay').addEventListener('click', (ev)=>{ if(ev.target.id === 'overlay') closeModal(); });
  document.getElementById('addDayBtn2').onclick = ()=>addAnotherDayFor(p.id);
  document.getElementById('ocrBtn').onclick = ()=>runOcr(p.id);
  document.getElementById('saveLabelBtn').onclick = async ()=>{
    p.label = document.getElementById('patientLabelEditInput').value.trim();
    await idbPut('patients', p);
    showToast('Saved');
    renderLists();
  };
  document.getElementById('saveFollowUpBtn').onclick = async ()=>{
    p.followUpInstructions = document.getElementById('followUpInput').value.trim();
    await idbPut('patients', p);
    showToast('Follow-up instructions saved');
  };

  const markBtn = document.getElementById('markDischargedBtn');
  if(markBtn){
    markBtn.onclick = async ()=>{
      p.dischargedAt = document.getElementById('dischargeDateInput').value || today;
      await idbPut('patients', p);
      showToast('Marked as discharged');
      renderPatientSheet(patientId);
      renderLists();
    };
  }
  const undischargeBtn = document.getElementById('undischargeBtn');
  if(undischargeBtn){
    undischargeBtn.onclick = async ()=>{
      p.dischargedAt = null;
      await idbPut('patients', p);
      showToast('Discharge undone');
      renderPatientSheet(patientId);
      renderLists();
    };
  }

  const listEl = document.getElementById('patientLinesList');
  if(!lines.length){
    listEl.innerHTML = `<div class="empty">No billing entries yet for this patient.</div>`;
  } else {
    lines.forEach((e, idx)=>{
      const row = document.createElement('div');
      row.className = 'timeline-row';
      row.style.cursor = 'pointer';
      row.innerHTML = `
        <div class="timeline-marker">
          <div class="timeline-dot"></div>
          ${idx < lines.length - 1 ? '<div class="timeline-line"></div>' : ''}
        </div>
        <div class="timeline-content entry" style="margin-bottom:0;">
          <div class="entry-body">
            <div class="entry-mbs"><span class="encounter-tag">${encounterTypeLabel(e.encounterType)}</span>MBS ${escapeHtml((e.mbsList || []).join(', '))}</div>
            <div class="entry-meta">${formatDate(e.date)} · ${escapeHtml(e.location || '—')}</div>
          </div>
          <span class="badge badge-${e.status}">${statusLabel(e.status)}</span>
        </div>
      `;
      row.addEventListener('click', ()=>pushSheet(()=>renderEntrySheet(e.id)));
      listEl.appendChild(row);
    });
  }
}

// ---- Full searchable patient picker (for choosing an existing patient beyond the small chip strip) ----
function openPatientPicker(){
  navStack = [];
  pushSheet(renderPatientPickerSheet);
}
function renderPatientPickerSheet(){
  const root = document.getElementById('modalRoot');
  root.innerHTML = `
    <div class="overlay" id="overlay">
      <div class="sheet">
        <button class="sheet-close" id="closeSheet">✕</button>
        <h3>Choose a patient</h3>
        <input type="text" id="patientSearchInput" placeholder="Search by your shorthand, location, or date…">

        <label class="field-label">Filter by date</label>
        <select id="dateFilterMode">
          <option value="none">Any date</option>
          <option value="exact">Specific date</option>
          <option value="range">Date range</option>
          <option value="month">Month &amp; year</option>
        </select>
        <div id="dateFilterInputs" style="margin-top:8px;"></div>

        <label class="field-label">Sort by</label>
        <select id="patientSortSelect">
          <option value="recent">Most recently seen</option>
          <option value="entry_first">Date added: oldest first</option>
          <option value="entry_last">Date added: newest first</option>
          <option value="billing_first">Date of billing: earliest first</option>
          <option value="billing_last">Date of billing: latest first</option>
          <option value="alpha_az">Shorthand: A → Z</option>
          <option value="alpha_za">Shorthand: Z → A</option>
        </select>
        <label class="select-all-label" style="margin-top:10px;">
          <input type="checkbox" id="includeDischargedCheckbox"> Include discharged patients
        </label>
        <div id="patientPickerList" style="margin-top:12px;"></div>
      </div>
    </div>`;
  document.getElementById('closeSheet').onclick = closeModal;
  document.getElementById('overlay').addEventListener('click', (ev)=>{ if(ev.target.id === 'overlay') closeModal(); });
  document.getElementById('patientSearchInput').addEventListener('input', renderPatientPickerList);
  document.getElementById('patientSortSelect').addEventListener('change', renderPatientPickerList);
  document.getElementById('includeDischargedCheckbox').addEventListener('change', renderPatientPickerList);
  document.getElementById('dateFilterMode').addEventListener('change', ()=>{
    renderDateFilterInputs();
    renderPatientPickerList();
  });
  renderDateFilterInputs();
  renderPatientPickerList();
}

function renderDateFilterInputs(){
  const mode = document.getElementById('dateFilterMode').value;
  const container = document.getElementById('dateFilterInputs');
  if(mode === 'exact'){
    container.innerHTML = `<input type="date" id="dateFilterExact">`;
    document.getElementById('dateFilterExact').addEventListener('change', renderPatientPickerList);
  } else if(mode === 'range'){
    container.innerHTML = `
      <div class="date-filter-row">
        <input type="date" id="dateFilterFrom" aria-label="From date">
        <input type="date" id="dateFilterTo" aria-label="To date">
      </div>`;
    document.getElementById('dateFilterFrom').addEventListener('change', renderPatientPickerList);
    document.getElementById('dateFilterTo').addEventListener('change', renderPatientPickerList);
  } else if(mode === 'month'){
    container.innerHTML = `<input type="month" id="dateFilterMonth">`;
    document.getElementById('dateFilterMonth').addEventListener('change', renderPatientPickerList);
  } else {
    container.innerHTML = '';
  }
}

// True if this patient has at least one billing entry matching the selected date filter.
function patientMatchesDateFilter(patientId){
  const mode = document.getElementById('dateFilterMode').value;
  if(mode === 'none') return true;
  const entryDates = billingEntries.filter((e)=>e.patientId === patientId).map((e)=>e.date);
  if(!entryDates.length) return false;

  if(mode === 'exact'){
    const val = document.getElementById('dateFilterExact').value;
    if(!val) return true;
    return entryDates.includes(val);
  }
  if(mode === 'range'){
    const from = document.getElementById('dateFilterFrom').value;
    const to = document.getElementById('dateFilterTo').value;
    if(!from && !to) return true;
    return entryDates.some((d)=>(!from || d >= from) && (!to || d <= to));
  }
  if(mode === 'month'){
    const val = document.getElementById('dateFilterMonth').value; // "YYYY-MM"
    if(!val) return true;
    return entryDates.some((d)=>d.slice(0, 7) === val);
  }
  return true;
}

function patientPickerSortLabel(p){ return (p.label || '').trim().toLowerCase(); }

function patientMatchingDateEntries(patientId){
  const mode = document.getElementById('dateFilterMode').value;
  const entries = billingEntries.filter((e)=>e.patientId === patientId);
  if(mode === 'none') return null;
  let matches = entries;
  if(mode === 'exact'){
    const val = document.getElementById('dateFilterExact').value;
    if(val) matches = entries.filter((e)=>e.date === val);
  } else if(mode === 'range'){
    const from = document.getElementById('dateFilterFrom').value;
    const to = document.getElementById('dateFilterTo').value;
    if(from || to) matches = entries.filter((e)=>(!from || e.date >= from) && (!to || e.date <= to));
  } else if(mode === 'month'){
    const val = document.getElementById('dateFilterMonth').value;
    if(val) matches = entries.filter((e)=>e.date.slice(0, 7) === val);
  }
  return matches.slice().sort((a, b)=>a.date.localeCompare(b.date));
}

function comparePickerRows(mode, a, b){
  if(mode === 'alpha_az' || mode === 'alpha_za'){
    const la = patientPickerSortLabel(a.p), lb = patientPickerSortLabel(b.p);
    const aEmpty = la === '', bEmpty = lb === '';
    if(aEmpty !== bEmpty) return aEmpty ? 1 : -1; // patients with no shorthand sink to the bottom either way
    if(la < lb) return mode === 'alpha_az' ? -1 : 1;
    if(la > lb) return mode === 'alpha_az' ? 1 : -1;
    return 0;
  }
  if(mode === 'entry_first' || mode === 'entry_last'){
    const at = new Date(a.p.createdAt).getTime();
    const bt = new Date(b.p.createdAt).getTime();
    return mode === 'entry_first' ? at - bt : bt - at;
  }
  // billing_first, billing_last, and the default "recent" (= billing_last)
  const aHas = !!a.last, bHas = !!b.last;
  if(aHas !== bHas) return aHas ? -1 : 1; // patients with no billing entries yet sink to the bottom
  if(!aHas && !bHas) return 0;
  const wantAsc = mode === 'billing_first';
  if(a.last.date < b.last.date) return wantAsc ? -1 : 1;
  if(a.last.date > b.last.date) return wantAsc ? 1 : -1;
  return 0;
}

function renderPatientPickerList(){
  const listEl = document.getElementById('patientPickerList');
  if(!listEl) return;
  const q = document.getElementById('patientSearchInput').value.trim().toLowerCase();
  const sortMode = document.getElementById('patientSortSelect').value;
  const includeDischarged = document.getElementById('includeDischargedCheckbox').checked;

  const rows = activePatients().map((p)=>{
    const last = patientLastEntry(p.id);
    return { p, last };
  }).filter(({ p, last })=>{
    if(p.dischargedAt && !includeDischarged) return false;
    if(!patientMatchesDateFilter(p.id)) return false;
    if(!q) return true;
    const haystack = [
      p.label || '', p.ocrText || '',
      last ? last.location || '' : '', last ? last.date : ''
    ].join(' ').toLowerCase();
    return haystack.includes(q);
  }).sort((a, b)=>comparePickerRows(sortMode, a, b));

  if(!rows.length){
    listEl.innerHTML = `<div class="empty">${q || document.getElementById('dateFilterMode').value !== 'none' ? 'No patients match that search/filter.' : 'No patients yet — capture one from the form above.'}</div>`;
    return;
  }

  listEl.innerHTML = '';
  rows.forEach(({ p, last })=>{
    const row = document.createElement('div');
    row.className = 'picker-row';
    const matching = patientMatchingDateEntries(p.id);
    let metaText;
    if(matching && matching.length){
      const dateStrs = matching.map((e)=>formatDate(e.date));
      const shown = dateStrs.length > 3 ? dateStrs.slice(0, 3).join(', ') + ` +${dateStrs.length - 3} more` : dateStrs.join(', ');
      metaText = `Billed: ${shown}`;
    } else if(last){
      metaText = `Last seen ${formatDate(last.date)} · ${escapeHtml(last.location || '—')}`;
    } else {
      metaText = 'No billing entries yet';
    }
    if(p.dischargedAt) metaText += ` · Discharged ${formatDate(p.dischargedAt)}`;
    row.innerHTML = `
      <img src="${p.photoThumb}" alt="">
      <div class="picker-row-body">
        <div class="picker-row-label">${escapeHtml(patientDisplayName(p))}${p.dischargedAt ? '<span class="discharged-tag">Discharged</span>' : ''}</div>
        <div class="picker-row-meta">${metaText}</div>
      </div>
    `;
    row.addEventListener('click', ()=>{
      selectedPatientId = p.id;
      currentPhoto = null;
      setEncounterTypeField('inpatient_review');
      populatePatientStatusFields(p);
      closeModal();
      renderPhotoZone();
      document.getElementById('entryFormCard').scrollIntoView({ behavior:'smooth', block:'start' });
    });
    listEl.appendChild(row);
  });


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
    await Promise.all(toForward.map((e)=>{
      e.status = 'forwarded'; e.forwardedAt = now;
      if(!e.statusHistory) e.statusHistory = [];
      e.statusHistory.push({ status:'forwarded', at: now });
      return idbPut('billingEntries', e);
    }));
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
    line('Patient ref:', p && p.label ? `#${shortId(e.patientId)} (${p.label})` : `#${shortId(e.patientId)}`);
    line('Date of service:', formatDate(e.date));
    line('Location:', e.location);
    line('Encounter type:', encounterTypeLabel(e.encounterType));
    line('MBS item number(s):', (e.mbsList || []).join(', '));
    line('Note:', e.note);
    line('Status:', statusLabel(e.status));
    if(p && p.dischargedAt){
      line('Discharged:', formatDate(p.dischargedAt));
    }
    if(p && p.followUpInstructions){
      line('Follow-up instructions:', p.followUpInstructions);
    }

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
on('selectAllPending', 'change', (ev)=>{
  const selectable = activeEntries().filter((e)=>e.status === 'pending' || e.status === 'forwarded');
  if(ev.target.checked) selectable.forEach((e)=>selected.add(e.id));
  else selectable.forEach((e)=>selected.delete(e.id));
  renderLists();
});
on('bulkMarkBilledBtn', 'click', async ()=>{
  const list = activeEntries().filter((e)=>selected.has(e.id) && e.status !== 'billed');
  if(!list.length) return;
  const now = new Date();
  await Promise.all(list.map((e)=>{
    e.status = 'billed'; e.billedAt = now;
    if(!e.statusHistory) e.statusHistory = [];
    e.statusHistory.push({ status:'billed', at: now });
    return idbPut('billingEntries', e);
  }));
  selected.clear();
  showToast(`${list.length} ${list.length === 1 ? 'entry' : 'entries'} marked billed`);
  renderLists();
});
on('bulkExportBtn', 'click', ()=>{
  const list = activeEntries().filter((e)=>selected.has(e.id));
  if(!list.length){ showToast('Select entries to export first'); return; }
  generatePdf(list);
});

// ==========================================================================
// Settings — a single local clinician name, no switching/PIN. Kept simple on
// purpose: without a server, "multiple logins" can't be real authentication,
// so it's not worth the complexity or the risk of implying security it can't provide.
// ==========================================================================
on('settingsBtn', 'click', ()=>{
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

        <p class="section-title" style="margin-top:22px;">Your saved MBS items</p>
        <p class="mbs-hint" style="margin:0 0 10px 0;">Build your own shortlist of commonly-used item numbers — nothing is pre-filled, since only you know which are current and correct for your practice.</p>
        <div id="mbsFavoritesList"></div>
        <button class="btn btn-ghost btn-sm" id="addMbsFavoriteBtn" style="margin-top:10px;">+ Add saved item</button>
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

  const listEl = document.getElementById('mbsFavoritesList');
  if(!mbsFavorites.length){
    listEl.innerHTML = `<div class="empty">No saved items yet.</div>`;
  } else {
    listEl.innerHTML = '';
    mbsFavorites.forEach((f, idx)=>{
      const row = document.createElement('div');
      row.className = 'picker-row';
      row.style.cursor = 'default';
      row.innerHTML = `
        <div class="picker-row-body">
          <div class="picker-row-label">${escapeHtml(f.code)}</div>
          <div class="picker-row-meta">${escapeHtml(f.descriptor || '')}</div>
        </div>
        <button class="mbs-remove-btn" aria-label="Remove">×</button>
      `;
      row.querySelector('.mbs-remove-btn').addEventListener('click', async ()=>{
        mbsFavorites.splice(idx, 1);
        await idbSetSetting('mbsFavorites', mbsFavorites);
        renderSettingsSheet();
      });
      listEl.appendChild(row);
    });
  }
  document.getElementById('addMbsFavoriteBtn').onclick = ()=>pushSheet(renderAddMbsFavoriteSheet);
}

function renderAddMbsFavoriteSheet(){
  const root = document.getElementById('modalRoot');
  root.innerHTML = `
    <div class="overlay" id="overlay">
      <div class="sheet">
        <button class="sheet-close" id="backBtn" aria-label="Back">←</button>
        <h3>Add saved item</h3>
        <label class="field-label first">MBS item number</label>
        <input type="text" id="newFavCode" inputmode="numeric" placeholder="e.g. 55126">
        <label class="field-label">Descriptor (optional)</label>
        <input type="text" id="newFavDescriptor" placeholder="Your own short description">
        <div class="err" id="newFavErr"></div>
        <button class="btn btn-primary" id="saveFavBtn">Add</button>
      </div>
    </div>`;
  document.getElementById('backBtn').onclick = popSheet;
  document.getElementById('overlay').addEventListener('click', (ev)=>{ if(ev.target.id === 'overlay') closeModal(); });
  document.getElementById('saveFavBtn').onclick = async ()=>{
    const code = document.getElementById('newFavCode').value.trim();
    const descriptor = document.getElementById('newFavDescriptor').value.trim();
    if(!code){ document.getElementById('newFavErr').textContent = 'Enter an item number.'; return; }
    mbsFavorites.push({ code, descriptor });
    await idbSetSetting('mbsFavorites', mbsFavorites);
    closeModal();
    showToast('Saved item added');
  };
}

// ==========================================================================
// Dashboard — simple counts from existing on-device data, no server involved
// ==========================================================================
on('dashboardBtn', 'click', ()=>{
  navStack = [];
  pushSheet(renderDashboardSheet);
});

function renderDashboardSheet(){
  const all = activeEntries();
  const pendingCount = all.filter((e)=>e.status === 'pending').length;
  const forwardedCount = all.filter((e)=>e.status === 'forwarded').length;
  const billedCount = all.filter((e)=>e.status === 'billed').length;
  const total = all.length || 1;
  const alerts = computeMissedBillingAlerts();
  const dischargedCount = activePatients().filter((p)=>p.dischargedAt).length;

  const byLocation = {};
  all.forEach((e)=>{
    const loc = e.location || 'Unspecified';
    if(!byLocation[loc]) byLocation[loc] = { pending:0, forwarded:0, billed:0 };
    byLocation[loc][e.status] = (byLocation[loc][e.status] || 0) + 1;
  });
  const locations = Object.keys(byLocation).sort();

  const root = document.getElementById('modalRoot');
  root.innerHTML = `
    <div class="overlay" id="overlay">
      <div class="sheet">
        <button class="sheet-close" id="closeSheet">✕</button>
        <h3>Dashboard</h3>

        <div class="stat-grid">
          <div class="stat-card"><div class="num">${activePatients().length}</div><div class="lbl">Patients</div></div>
          <div class="stat-card"><div class="num">${all.length}</div><div class="lbl">Billing entries</div></div>
          <div class="stat-card"><div class="num">${pendingCount}</div><div class="lbl">Pending</div></div>
          <div class="stat-card"><div class="num">${forwardedCount}</div><div class="lbl">Forwarded</div></div>
          <div class="stat-card"><div class="num">${billedCount}</div><div class="lbl">Billed</div></div>
          <div class="stat-card"><div class="num">${dischargedCount}</div><div class="lbl">Discharged</div></div>
          <div class="stat-card"><div class="num">${alerts.length}</div><div class="lbl">Possible gaps</div></div>
        </div>

        ${alerts.length ? `<button class="btn btn-ghost btn-sm" id="viewGapsBtn" style="margin-bottom:16px;">View possible missed billing</button>` : ''}

        <p class="section-title">By location</p>
        <div class="loc-bar-legend" style="margin-bottom:10px;">
          <span><span class="legend-dot" style="background:var(--pending);"></span>Pending</span>
          <span><span class="legend-dot" style="background:var(--forwarded);"></span>Forwarded</span>
          <span><span class="legend-dot" style="background:var(--success);"></span>Billed</span>
        </div>
        <div id="dashboardLocations"></div>
      </div>
    </div>`;
  document.getElementById('closeSheet').onclick = closeModal;
  document.getElementById('overlay').addEventListener('click', (ev)=>{ if(ev.target.id === 'overlay') closeModal(); });
  const viewGapsBtn = document.getElementById('viewGapsBtn');
  if(viewGapsBtn) viewGapsBtn.onclick = ()=>pushSheet(renderMissedBillingSheet);

  const locEl = document.getElementById('dashboardLocations');
  if(!locations.length){
    locEl.innerHTML = `<div class="empty">No billing entries yet.</div>`;
  } else {
    locations.forEach((loc)=>{
      const counts = byLocation[loc];
      const locTotal = counts.pending + counts.forwarded + counts.billed || 1;
      const row = document.createElement('div');
      row.className = 'loc-bar-row';
      row.innerHTML = `
        <div class="loc-name">${escapeHtml(loc)} <span style="color:var(--muted); font-weight:500;">(${counts.pending + counts.forwarded + counts.billed})</span></div>
        <div class="loc-bar-track">
          <div class="loc-bar-seg" style="width:${(counts.pending / locTotal) * 100}%; background:var(--pending);"></div>
          <div class="loc-bar-seg" style="width:${(counts.forwarded / locTotal) * 100}%; background:var(--forwarded);"></div>
          <div class="loc-bar-seg" style="width:${(counts.billed / locTotal) * 100}%; background:var(--success);"></div>
        </div>
      `;
      locEl.appendChild(row);
    });
  }
}

// ==========================================================================
// Reports (CSV / XLSX / PDF audit export)
// ==========================================================================
on('reportsBtn', 'click', ()=>{
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
    .map((e)=>{
      const p = findPatient(e.patientId);
      return {
        date: e.date,
        location: e.location || '',
        patientId: e.patientId,
        patientRef: p && p.label ? `#${shortId(e.patientId)} (${p.label})` : `#${shortId(e.patientId)}`,
        encounterType: encounterTypeLabel(e.encounterType),
        mbs: (e.mbsList || []).join(', '),
        note: e.note || '',
        status: statusLabel(e.status),
        billedAt: e.billedAt ? new Date(e.billedAt).toLocaleString('en-AU') : '',
        clinician: clinicianName || 'Not set'
      };
    });
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
    const headers = ['Date','Location','Patient Ref','Encounter Type','MBS Item(s)','Note','Status','Billed At','Clinician'];
    const escapeCsv = (v)=>`"${String(v).replace(/"/g, '""')}"`;
    const lines = [headers.map(escapeCsv).join(',')]
      .concat(rows.map((r)=>[r.date, r.location, r.patientRef, r.encounterType, r.mbs, r.note, r.status, r.billedAt, r.clinician].map(escapeCsv).join(',')));
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
        Date:r.date, Location:r.location, 'Patient Ref':r.patientRef, 'Encounter Type':r.encounterType, 'MBS Item(s)':r.mbs,
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

    const headers = ['Date','Location','Patient Ref','Encounter','MBS Item(s)','Note','Status','Billed At'];
    const colX =    [30,    85,        175,           250,        320,          430,   560,     620];
    const maxChars = [10,   16,        14,            11,         20,           22,    12,       26];
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
      const vals = [r.date, r.location, r.patientRef, r.encounterType, r.mbs, r.note, r.status, r.billedAt];
      vals.forEach((v, j)=>doc.text(String(v || '—').slice(0, maxChars[j]), colX[j], y));
      y += 15;
    });

    // Photo appendix — one page per unique patient in this report, portrait, for legibility
    const uniquePatientIds = [...new Set(rows.map((r)=>r.patientId))];
    uniquePatientIds.forEach((pid, idx)=>{
      const p = findPatient(pid);
      doc.addPage('a4', 'portrait');
      doc.setFontSize(13); doc.setTextColor(18, 42, 69);
      doc.text(`Appendix ${idx + 1} of ${uniquePatientIds.length} — Patient #${shortId(pid)}${p && p.label ? ' (' + p.label + ')' : ''}`, 40, 40);
      doc.setFontSize(9); doc.setTextColor(107, 119, 133);
      const datesForPatient = rows.filter((r)=>r.patientId === pid).map((r)=>r.date).join(', ');
      let infoY = 58;
      doc.text(`Billing dates in this report: ${datesForPatient}`, 40, infoY);
      infoY += 16;
      if(p && p.dischargedAt){
        doc.text(`Discharged: ${formatDate(p.dischargedAt)}`, 40, infoY);
        infoY += 16;
      }
      if(p && p.followUpInstructions){
        doc.text(`Follow-up: ${p.followUpInstructions}`, 40, infoY);
        infoY += 16;
      }
      embedPhotoInPdf(doc, p ? p.photoFull : null, 40, infoY + 5, 515, 700 - infoY);
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

// One-time backfill so entries created before status history / encounter type existed
// still show something sensible, rather than blank fields.
async function backfillEntryFields(){
  const updates = [];
  billingEntries.forEach((e)=>{
    let changed = false;
    if(!e.encounterType){ e.encounterType = 'inpatient_review'; changed = true; }
    if(!e.statusHistory || !e.statusHistory.length){
      const hist = [{ status:'pending', at: e.createdAt || new Date() }];
      if(e.forwardedAt) hist.push({ status:'forwarded', at: e.forwardedAt });
      if(e.billedAt) hist.push({ status:'billed', at: e.billedAt });
      e.statusHistory = hist;
      changed = true;
    }
    if(changed) updates.push(idbPut('billingEntries', e));
  });
  if(updates.length) await Promise.all(updates);
}

async function init(){
  try{
    await migrateLegacyIfNeeded();
    clinicianName = await migrateNameFromOldMultiLoginIfNeeded();
    [patients, billingEntries, mbsFavorites] = await Promise.all([
      idbAll('patients'), idbAll('billingEntries'), idbGetSetting('mbsFavorites')
    ]);
    mbsFavorites = mbsFavorites || [];
    await backfillEntryFields();
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
