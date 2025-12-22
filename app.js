/* APP_BUILD_TAG: v21-mood-modal */
console.log('Daily Check-In build v21 (mood modal)');
function getStoredConfig() {
  try {
    const raw = localStorage.getItem("cc_firebase_config");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function getStoredRoom() {
  return (localStorage.getItem("cc_room_id") || "").trim();
}

const setupWarn = document.getElementById("setupWarn");
const cfg = getStoredConfig();
const ROOM_ID = getStoredRoom();

if (!cfg || !ROOM_ID) {
  setupWarn.textContent = "⚠️ Not set up yet. Open Setup and save your Firebase config + Room ID.";
}

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  onSnapshot,
  serverTimestamp,
  collection,
  query,
  where,
  orderBy,  getDocs,
  limit
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getStorage, ref as sRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js";

const MIN_YEAR = 2020;
const MAX_YEAR = 2040;

const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");

const roleH = document.getElementById("roleH");
const roleW = document.getElementById("roleW");
const roleLabel = document.getElementById("roleLabel");

const monthSel = document.getElementById("monthSel");
const yearSel = document.getElementById("yearSel");
const todayBtn = document.getElementById("todayBtn");
const notifBtn = document.getElementById("notifBtn");
const reviewBtn = document.getElementById("reviewBtn");
const reviewSection = document.getElementById("reviewSection");
const reviewBackBtn = document.getElementById("reviewBackBtn");
const reviewYearLabel = document.getElementById("reviewYearLabel");
const statBoth = document.getElementById("statBoth");
const statPhotos = document.getElementById("statPhotos");
const statLongest = document.getElementById("statLongest");
const statBestMonth = document.getElementById("statBestMonth");
const reviewHeatmap = document.getElementById("reviewHeatmap");
const reviewReel = document.getElementById("reviewReel");

const actionsSection = document.querySelector("section.actions");
const calendarSection = document.querySelector("section.calendar");

const streakNowEl = document.getElementById("streakNow");
const streakBestEl = document.getElementById("streakBest");

const grid = document.getElementById("grid");
const cameraInput = document.getElementById("cameraInput");

function setStatus(ok, text) {
  statusText.textContent = text;
  statusDot.style.opacity = ok ? "1" : ".55";
  statusDot.style.filter = ok ? "none" : "grayscale(1)";
}

if (!cfg || !ROOM_ID) {
  setStatus(false, "Setup required");
}

const app = cfg ? initializeApp(cfg) : null;
const auth = app ? getAuth(app) : null;
const db = app ? getFirestore(app) : null;

// Be resilient to a common setup mistake where users paste a Storage "domain"
// (e.g. "<project>.firebasestorage.app") instead of the bucket name
// ("<project>.appspot.com"). If we have a projectId, we can safely default
// to the standard bucket name.
function getStorageBucketName(firebaseConfig) {
  if (!firebaseConfig) return null;
  const sb = firebaseConfig.storageBucket;
  // Firebase commonly provides either:
  //  - <project>.appspot.com
  //  - <project>.firebasestorage.app
  //  - gs://<bucket>
  // We should accept any valid bucket string and only fall back if it's missing.
  if (typeof sb === 'string' && sb.trim()) {
    let trimmed = sb.trim().replace(/^gs:\/\//i, '');
    if (trimmed.includes('appspot.com') || trimmed.includes('firebasestorage.app')) return trimmed;
    // If they pasted some other bucket-like name (contains a dot), accept it.
    if (trimmed.includes('.')) return trimmed;
    // Otherwise keep going and fall back.
  }

  if (typeof firebaseConfig.projectId === 'string' && firebaseConfig.projectId.trim()) {
    return `${firebaseConfig.projectId.trim()}.appspot.com`;
  }
  return null;
}

const storageBucketName = app ? getStorageBucketName(cfg) : null;
const storage = app
  ? (storageBucketName ? getStorage(app, `gs://${storageBucketName}`) : getStorage(app))
  : null;

// Auth readiness gate (mobile can be slow to establish an Anonymous session).
let _resolveAuthReady;
const authReady = new Promise((resolve) => {
  _resolveAuthReady = resolve;
});

let activeRole = "husband";
let monthCache = new Map(); // dayId -> data

function setRole(role){
  activeRole = role;
  if (role === "husband") {
    roleH.classList.add("active");
    roleW.classList.remove("active");
    roleLabel.textContent = "Husband";
  } else {
    roleW.classList.add("active");
    roleH.classList.remove("active");
    roleLabel.textContent = "Wife";
  }
  for (const [dayId, data] of monthCache) applyDayData(dayId, data);
}
roleH.addEventListener("click", () => setRole("husband"));
roleW.addEventListener("click", () => setRole("wife"));

setRole("husband");


// ---------------- Notes (private per role, per day) ----------------
async function saveNoteForDay(dayId, role, text){
  if (!db || !ROOM_ID) throw new Error("Not connected");
  const key = role === "husband" ? "husbandNote" : "wifeNote";
  const dayRef = doc(db, "rooms", ROOM_ID, "days", dayId);
  await setDoc(dayRef, { dayId, [key]: String(text || "") }, { merge: true });
}
// ---------------- Year in Review ----------------
function setReviewMode(on){
  if (!reviewSection || !actionsSection || !calendarSection) return;
  if (on){
    actionsSection.classList.add("hidden");
    calendarSection.classList.add("hidden");
    reviewSection.classList.remove("hidden");
  } else {
    reviewSection.classList.add("hidden");
    actionsSection.classList.remove("hidden");
    calendarSection.classList.remove("hidden");
  }
}

function monthName(m){ return MONTHS[m]; }

function dayKey(y,m,d){
  const mm = String(m+1).padStart(2,"0");
  const dd = String(d).padStart(2,"0");
  return `${y}-${mm}-${dd}`;
}

function computeLongestBothStreakInYear(year, docsById){
  const start = new Date(year,0,1);
  const end = new Date(year,11,31);
  let best = 0;
  let cur = 0;
  const c = new Date(start);
  while (c <= end){
    const id = dayIdFromDate(c);
    const data = docsById[id];
    const both = !!(data && data.husbandUrl && data.wifeUrl);
    if (both){ cur += 1; best = Math.max(best, cur); }
    else { cur = 0; }
    c.setDate(c.getDate()+1);
  }
  return best;
}

function pickRandomMemories(docsById, count=12){
  const ids = [];
  for (const [id, data] of Object.entries(docsById)){
    if (data && data.husbandUrl && data.wifeUrl) ids.push(id);
  }
  // Shuffle for randomness each time the review loads
  for (let i = ids.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
  }
  return ids.slice(0, Math.min(count, ids.length));
}

function renderHeatmap(year, docsById){
  if (!reviewHeatmap) return;
  reviewHeatmap.innerHTML = "";

  for (let m=0;m<12;m++){
    const box = document.createElement("div");
    box.className = "miniMonth";

    const top = document.createElement("div");
    top.className = "miniMonthTop";
    top.innerHTML = `<div class="miniMonthName">${monthName(m)}</div><div class="miniMonthKey muted">⬜ none · 🟣 one · 💗 both</div>`;
    box.appendChild(top);

    const grid = document.createElement("div");
    grid.className = "miniGrid";

    const first = new Date(year, m, 1);
    const dow = (first.getDay()+6)%7; // Mon-first

    for (let i=0;i<dow;i++){
      const c = document.createElement("div");
      c.className = "miniCell off";
      grid.appendChild(c);
    }

    const daysInMonth = new Date(year, m+1, 0).getDate();
    for (let d=1; d<=daysInMonth; d++){
      const id = dayKey(year,m,d);
      const data = docsById[id];
      const hasH = !!(data && data.husbandUrl);
      const hasW = !!(data && data.wifeUrl);

      const c = document.createElement("button");
      c.type = "button";
      c.className = "miniCell" + (hasH||hasW ? (hasH&&hasW ? " both" : " one") : "");
      c.title = id;

      if (hasH || hasW){
        c.addEventListener("click", () => openViewer(id, data));
      } else {
        c.addEventListener("click", () => {
          setReviewMode(false);
          monthSel.value = String(m);
          yearSel.value = String(year);
          renderCalendar();
          attachMonthListener();
        });
      }

      grid.appendChild(c);
    }

    box.appendChild(grid);
    reviewHeatmap.appendChild(box);
  }
}

function renderMemoryReel(year, docsById){
  if (!reviewReel) return;
  reviewReel.innerHTML = "";

  // Build pools for each role from ANY day in the year
  const husbandIds = [];
  const wifeIds = [];
  for (const [id, data] of Object.entries(docsById)){
    if (!data) continue;
    if (data.husbandUrl) husbandIds.push(id);
    if (data.wifeUrl) wifeIds.push(id);
  }

  function pickOne(arr){
    if (!arr.length) return null;
    const idx = Math.floor(Math.random() * arr.length);
    return arr[idx];
  }

  const hId = pickOne(husbandIds);
  const wId = pickOne(wifeIds);

  if (!hId && !wId){
    reviewReel.innerHTML = `<div class="muted">No photos found yet for ${year}. Take your first check‑in and it will appear here ❤️</div>`;
    return;
  }

  // Husband single card
  if (hId){
    const data = docsById[hId];
    const h = document.createElement("button");
    h.type = "button";
    h.className = "reelItem";
    h.innerHTML = `
      <img class="reelThumb" alt="Husband photo ${hId}" src="${data.husbandUrl}">
      <div class="reelMeta">
        <div class="reelRole"><span class="reelRoleDot"></span>Husband</div>
        <div class="muted">${hId}</div>
      </div>
    `;
    // Keep your existing viewer logic (shows the day in-app)
    h.addEventListener("click", () => openViewer(hId, data));
    reviewReel.appendChild(h);
  }

  // Wife single card
  if (wId){
    const data = docsById[wId];
    const w = document.createElement("button");
    w.type = "button";
    w.className = "reelItem";
    w.innerHTML = `
      <img class="reelThumb" alt="Wife photo ${wId}" src="${data.wifeUrl}">
      <div class="reelMeta">
        <div class="reelRole"><span class="reelRoleDot"></span>Wife</div>
        <div class="muted">${wId}</div>
      </div>
    `;
    w.addEventListener("click", () => openViewer(wId, data));
    reviewReel.appendChild(w);
  }
}

async function buildYearReview(){
  if (!db) return;
  const year = Number(yearSel.value);
  if (!year || !reviewSection) return;

  if (reviewYearLabel) reviewYearLabel.textContent = String(year);

  const daysCol = collection(db, "rooms", ROOM_ID, "days");
  const startId = `${year}-01-01`;
  const endId = `${year}-12-31`;
  const q = query(daysCol, where("dayId", ">=", startId), where("dayId", "<=", endId));
  const snap = await getDocs(q);

  const docsById = {};
  snap.forEach((docSnap) => {
    const data = docSnap.data() || {};
    const id = data.dayId || docSnap.id;
    docsById[id] = data;
  });

  let both = 0, photos = 0;
  const monthBoth = Array(12).fill(0);

  for (const [id, data] of Object.entries(docsById)){
    const hasH = !!data.husbandUrl;
    const hasW = !!data.wifeUrl;
    if (hasH) photos++;
    if (hasW) photos++;
    if (hasH && hasW){
      both++;
      const m = Number(String(id).slice(5,7)) - 1;
      if (m>=0 && m<12) monthBoth[m] += 1;
    }
  }

  const longest = computeLongestBothStreakInYear(year, docsById);
  let bestMonthIdx = 0;
  for (let i=1;i<12;i++){
    if (monthBoth[i] > monthBoth[bestMonthIdx]) bestMonthIdx = i;
  }
  const bestMonthText = monthBoth[bestMonthIdx] ? `${monthName(bestMonthIdx)} (${monthBoth[bestMonthIdx]})` : "—";

  if (statBoth) statBoth.textContent = String(both);
  if (statPhotos) statPhotos.textContent = String(photos);
  if (statLongest) statLongest.textContent = String(longest);
  if (statBestMonth) statBestMonth.textContent = bestMonthText;

  renderHeatmap(year, docsById);
  renderMemoryReel(year, docsById);
}

if (reviewBtn){
  reviewBtn.addEventListener("click", async () => {
    if (!cfg || !ROOM_ID){
      setReviewMode(true);
      if (reviewYearLabel) reviewYearLabel.textContent = String(yearSel.value || new Date().getFullYear());
      if (reviewHeatmap) reviewHeatmap.innerHTML = `<div class="muted">Finish Setup first to see your review ✨</div>`;
      if (reviewReel) reviewReel.innerHTML = "";
      return;
    }
    setReviewMode(true);
    try {
      if (reviewYearLabel) reviewYearLabel.textContent = String(yearSel.value || new Date().getFullYear());
      await authReady;
      await buildYearReview();
    } catch (e){
      console.error(e);
      if (reviewHeatmap) reviewHeatmap.innerHTML = `<div class="muted">Couldn’t load the review. Open Safari → Settings → Advanced → Website Data and clear for this site, then try again.</div>`;
    }
  });
}
if (reviewBackBtn){
  reviewBackBtn.addEventListener("click", () => setReviewMode(false));
}

yearSel.addEventListener("change", async () => {
  if (reviewSection && !reviewSection.classList.contains("hidden")){
    try { await buildYearReview(); } catch(e){ console.error(e); }
  }
});


const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
for (let i=0;i<12;i++){
  const opt = document.createElement("option");
  opt.value = String(i);
  opt.textContent = MONTHS[i];
  monthSel.appendChild(opt);
}
for (let y=MIN_YEAR;y<=MAX_YEAR;y++){
  const opt = document.createElement("option");
  opt.value = String(y);
  opt.textContent = String(y);
  yearSel.appendChild(opt);
}

function pad2(n){ return String(n).padStart(2,"0"); }
function dayIdFromDate(d){
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}

function prettyDateFromDayId(dayId){
  try{
    const [y,m,d] = dayId.split('-').map(Number);
    const dt = new Date(y, (m||1)-1, d||1);
    return dt.toLocaleDateString(undefined, { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  }catch(e){
    return dayId;
  }
}
function setSelectedDay(dayId){
  selectedDayId = dayId;
  if(qaDateEl) qaDateEl.textContent = prettyDateFromDayId(dayId);
  attachSelectedDayListener();
}
function setIfNotFocused(el, value){
  if(!el) return;
  const v = (value ?? '');
  if(document.activeElement === el) return;
  if(el.value !== v) el.value = v;
}
function disableQA(msg){
  [...hQ, ...wQ].forEach(t => { if(t){ t.disabled = true; t.placeholder = msg || 'Complete Setup to enable.'; } });
  if(hClearBtn) hClearBtn.disabled = true;
  if(wClearBtn) wClearBtn.disabled = true;
  if(qaHintEl) qaHintEl.textContent = msg || '';
}
function enableQA(){
  [...hQ, ...wQ].forEach(t => { if(t){ t.disabled = false; } });
  if(hClearBtn) hClearBtn.disabled = false;
  if(wClearBtn) wClearBtn.disabled = false;
  if(qaHintEl) qaHintEl.textContent = 'Answers save automatically and sync to the other device.';
}
function dayRefFor(dayId){
  return doc(db, `rooms/${ROOM_ID}/days/${dayId}`);
}
function readQAIntoUI(data){
  const ha = data.husbandAnswers || {};
  const wa = data.wifeAnswers || {};
  setIfNotFocused(hQ[0], ha.q1);
  setIfNotFocused(hQ[1], ha.q2);
  setIfNotFocused(hQ[2], ha.q3);
  setIfNotFocused(hQ[3], ha.q4);
  setIfNotFocused(wQ[0], wa.q1);
  setIfNotFocused(wQ[1], wa.q2);
  setIfNotFocused(wQ[2], wa.q3);
  setIfNotFocused(wQ[3], wa.q4);
}
function attachSelectedDayListener(){
  if(!db || !ROOM_ID){
    disableQA('Go to Setup and save your Firebase config + Room ID to enable daily questions.');
    return;
  }
  enableQA();
  if(unsubscribeSelectedDay) unsubscribeSelectedDay();
  const ref = dayRefFor(selectedDayId);
  unsubscribeSelectedDay = onSnapshot(ref, (snap) => {
    if(!snap.exists()){
      readQAIntoUI({});
      return;
    }
    readQAIntoUI(snap.data() || {});
  });
}
function collectRoleAnswers(role){
  const arr = (role === 'husband') ? hQ : wQ;
  return {
    q1: (arr[0]?.value || '').trim(),
    q2: (arr[1]?.value || '').trim(),
    q3: (arr[2]?.value || '').trim(),
    q4: (arr[3]?.value || '').trim(),
  };
}
async function saveRoleAnswers(role){
  if(!db || !ROOM_ID) return;
  const ref = dayRefFor(selectedDayId);
  const field = role === 'husband' ? 'husbandAnswers' : 'wifeAnswers';
  const payload = { dayId: selectedDayId, [field]: collectRoleAnswers(role) };
  try{
    await setDoc(ref, payload, { merge: true });
    const el = role === 'husband' ? hSavedEl : wSavedEl;
    if(el){
      el.textContent = 'Saved ✓';
      setTimeout(() => { if(el.textContent === 'Saved ✓') el.textContent = ''; }, 1200);
    }
  }catch(e){
    console.error(e);
    const el = role === 'husband' ? hSavedEl : wSavedEl;
    if(el) el.textContent = 'Could not save';
  }
}
function scheduleSave(role){
  clearTimeout(saveTimers[role]);
  saveTimers[role] = setTimeout(() => saveRoleAnswers(role), 600);
}
function wireQA(){
  // autosave on typing
  hQ.forEach(t => t && t.addEventListener('input', () => scheduleSave('husband')));
  wQ.forEach(t => t && t.addEventListener('input', () => scheduleSave('wife')));
  if(hClearBtn) hClearBtn.addEventListener('click', async () => {
    hQ.forEach(t => { if(t) t.value=''; });
    await saveRoleAnswers('husband');
  });
  if(wClearBtn) wClearBtn.addEventListener('click', async () => {
    wQ.forEach(t => { if(t) t.value=''; });
    await saveRoleAnswers('wife');
  });
}
function dateFromDayId(dayId){
  const [y,m,d] = dayId.split("-").map(Number);
  return new Date(y, m-1, d);
}

const now = new Date();
let viewYear = Math.min(MAX_YEAR, Math.max(MIN_YEAR, now.getFullYear()));
let viewMonth = now.getMonth();
monthSel.value = String(viewMonth);
yearSel.value = String(viewYear);

todayBtn.addEventListener("click", () => {
  const d = new Date();
  viewYear = Math.min(MAX_YEAR, Math.max(MIN_YEAR, d.getFullYear()));
  viewMonth = d.getMonth();
  monthSel.value = String(viewMonth);
  yearSel.value = String(viewYear);
  renderCalendar();
  attachMonthListener();
  wireQA();
  setSelectedDay(dayIdFromDate(new Date()));
});

monthSel.addEventListener("change", () => {
  viewMonth = Number(monthSel.value);
  renderCalendar();
  attachMonthListener();
  wireQA();
  setSelectedDay(dayIdFromDate(new Date()));
});
yearSel.addEventListener("change", () => {
  viewYear = Number(yearSel.value);
  renderCalendar();
  attachMonthListener();
  wireQA();
  setSelectedDay(dayIdFromDate(new Date()));
});

function dayDoc(dayId){
  return doc(db, "rooms", ROOM_ID, "days", dayId);
}
function storagePath(role, dayId){
  return `rooms/${ROOM_ID}/${role}/${dayId}/photo.jpg`;
}

async function compressImage(file, maxW=1280, quality=0.82){
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxW / bitmap.width);
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);

  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
  return blob ? new File([blob], "photo.jpg", { type: "image/jpeg" }) : file;
}

let dayCells = new Map();

function renderCalendar(){
  grid.innerHTML = "";
  dayCells.clear();
  monthCache.clear();

  const first = new Date(viewYear, viewMonth, 1);
  const jsDow = first.getDay();
  const mondayIndex = (jsDow + 6) % 7;
  const start = new Date(viewYear, viewMonth, 1 - mondayIndex);

  for (let i=0;i<42;i++){
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const dayId = dayIdFromDate(d);
    const inMonth = d.getMonth() === viewMonth;

    const cell = document.createElement("div");
    cell.className = "day" + (inMonth ? "" : " mutedDay");
    cell.dataset.dayId = dayId;
    cell.innerHTML = `
      <div class="bg"></div>
      <div class="shade"></div>
      <div class="num">${d.getDate()}</div>
      <div class="badges"></div>
    `;
    cell.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleDayTap(dayId);
    });
    grid.appendChild(cell);
    dayCells.set(dayId, cell);
  }
}

function monthStartEnd(){
  const first = new Date(viewYear, viewMonth, 1);
  const jsDow = first.getDay();
  const mondayIndex = (jsDow + 6) % 7;
  const start = new Date(viewYear, viewMonth, 1 - mondayIndex);
  const end = new Date(start);
  end.setDate(start.getDate() + 41);
  return { startId: dayIdFromDate(start), endId: dayIdFromDate(end) };
}

function applyDayData(dayId, data){
  const cell = dayCells.get(dayId);
  if (!cell) return;

  const bg = cell.querySelector(".bg");
  const badges = cell.querySelector(".badges");
  const husbandUrl = data?.husbandUrl || "";
  const wifeUrl = data?.wifeUrl || "";

  const preferred = (activeRole === "husband" ? (husbandUrl || wifeUrl) : (wifeUrl || husbandUrl));
  bg.style.backgroundImage = preferred ? `url('${preferred}')` : "none";

  badges.innerHTML = "";
  if (husbandUrl) badges.insertAdjacentHTML("beforeend", `<div class="badge"><span class="mini husband"></span>H</div>`);
  if (wifeUrl) badges.insertAdjacentHTML("beforeend", `<div class="badge"><span class="mini wife"></span>W</div>`);
}

let unsubscribeMonth = null;
function attachMonthListener(){
  if (!db) return;
  if (unsubscribeMonth) unsubscribeMonth();
  setStatus(false, "Connecting…");

  const { startId, endId } = monthStartEnd();
  const daysCol = collection(db, "rooms", ROOM_ID, "days");
  const q = query(daysCol, where("dayId", ">=", startId), where("dayId", "<=", endId));

  unsubscribeMonth = onSnapshot(q, (snap) => {
    setStatus(true, "Online");
    for (const [dayId] of dayCells) applyDayData(dayId, {});
    monthCache.clear();
    snap.forEach((docSnap) => {
      const data = docSnap.data() || {};
      monthCache.set(docSnap.id, data);
      applyDayData(docSnap.id, data);
    });
  }, (err) => {
    console.error(err);
    setStatus(false, "Permission issue (rules?)");
  });
}

function computeStreakFromDocs(docsById){
  const today = new Date();
  today.setHours(0,0,0,0);

  let current = 0;
  let cursor = new Date(today);

  while (true) {
    const id = dayIdFromDate(cursor);
    const data = docsById.get(id);
    if (data && data.husbandUrl && data.wifeUrl) {
      current += 1;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }

  const ids = Array.from(docsById.keys()).sort();
  let best = 0;
  let run = 0;
  let prevDate = null;

  for (const id of ids) {
    const data = docsById.get(id);
    if (!(data && data.husbandUrl && data.wifeUrl)) continue;
    const dt = dateFromDayId(id);
    dt.setHours(0,0,0,0);
    if (prevDate) {
      const diff = Math.round((dt - prevDate) / (1000*60*60*24));
      run = (diff === 1) ? run + 1 : 1;
    } else {
      run = 1;
    }
    prevDate = dt;
    if (run > best) best = run;
  }

  return { current, best };
}

let unsubscribeStreak = null;
function attachStreakListener(){
  if (!db) return;
  if (unsubscribeStreak) unsubscribeStreak();

  const daysCol = collection(db, "rooms", ROOM_ID, "days");
  const q = query(daysCol, orderBy("__name__", "desc"), limit(800));

  unsubscribeStreak = onSnapshot(q, (snap) => {
    const docsById = new Map();
    snap.forEach((docSnap) => docsById.set(docSnap.id, docSnap.data() || {}));
    const { current, best } = computeStreakFromDocs(docsById);
    if (streakNowEl) streakNowEl.textContent = String(current);
    if (streakBestEl) streakBestEl.textContent = String(best);
  }, (err) => console.error(err));
}

let pendingDayId = null;
async function openCameraForDay(dayId){
  if (!storage || !db) {
    alert("Open Setup and save your Firebase config + Room ID first.");
    return;
  }
  // On mobile Safari especially, a user can tap a day before anonymous auth finishes.
  // Storage rules typically require request.auth != null, so wait for auth to be ready.
  if (auth && !auth.currentUser) {
    try {
      await Promise.race([
        authReady,
        new Promise((_, rej) => setTimeout(() => rej(new Error("auth-timeout")), 8000)),
      ]);
    } catch (_) {
      // fall through to the check below
    }
  }
  if (auth && !auth.currentUser) {
    alert("Auth is still starting. Please wait 1–2 seconds and try again.");
    return;
  }
  pendingDayId = dayId;
  cameraInput.value = "";
  cameraInput.click();
}

// ----- Day tap menu: View or Take -----
let __dayMenuBuilt = false;
function ensureDayMenu() {
  if (__dayMenuBuilt) return;
  __dayMenuBuilt = true;

  const style = document.createElement("style");
  style.textContent = `
  .dc-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:flex-end;justify-content:center;z-index:9999;}
  .dc-overlay.show{display:flex;}
  .dc-sheet{width:min(520px,92vw);margin:0 0 18px 0;background:rgba(30,20,55,.92);border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:14px;backdrop-filter: blur(10px);}
  .dc-sheet h3{margin:0 0 10px 0;font-size:16px;color:#fff;}
  .dc-sheet .row{display:flex;gap:10px;flex-wrap:wrap;}
  .dc-btn{appearance:none;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.08);color:#fff;padding:10px 12px;border-radius:12px;font-weight:700;cursor:pointer;}
  .dc-btn.primary{background:rgba(120,160,255,.22);}
  .dc-btn.danger{background:rgba(255,100,140,.18);}
  .dc-view{position:fixed;inset:0;background:rgba(0,0,0,.7);display:none;align-items:center;justify-content:center;z-index:10000;}
  .dc-view.show{display:flex;}
  .dc-view-card{width:min(760px,92vw);max-height:86vh;overflow:auto;background:rgba(30,20,55,.92);border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:14px;backdrop-filter: blur(10px);color:#fff;}
  .dc-view-top{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px;}
  .dc-x{font-size:18px;line-height:1;border:none;background:rgba(255,255,255,.08);color:#fff;border-radius:10px;padding:8px 10px;cursor:pointer;}
  .dc-img{width:100%;border-radius:14px;border:1px solid rgba(255,255,255,.12);margin:8px 0;}
  .dc-label{font-weight:800;margin-top:10px;opacity:.9;}
  `;
  document.head.appendChild(style);

  const overlay = document.createElement("div");
  overlay.id = "dcDayOverlay";
  overlay.className = "dc-overlay";
  overlay.innerHTML = `
    <div class="dc-sheet" role="dialog" aria-modal="true">
      <h3 id="dcDayTitle">Day</h3>
      <div class="row" style="margin-bottom:10px;">
        <button class="dc-btn primary" id="dcBtnTake" type="button">Take / Replace photo</button>
        <button class="dc-btn" id="dcBtnView" type="button">View photo</button>
        <button class="dc-btn" id="dcBtnMood" type="button">Sleep Emoji Mood</button>
      </div>
      <div class="row">
        <button class="dc-btn" id="dcBtnCancel" type="button">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const viewer = document.createElement("div");
  viewer.id = "dcViewer";
  viewer.className = "dc-view";
  viewer.innerHTML = `
    <div class="dc-view-card" role="dialog" aria-modal="true">
      <div class="dc-view-top">
        <div style="font-weight:900;" id="dcViewerTitle">Photos</div>
        <button class="dc-x" id="dcViewerClose" type="button">✕</button>
      </div>
      <div id="dcViewerBody"></div>
    </div>
  `;
  document.body.appendChild(viewer);

  // Close handlers
  overlay.addEventListener("click", (e) => { if (e.target === overlay) hideDayMenu(); });
  viewer.addEventListener("click", (e) => { if (e.target === viewer) hideViewer(); });
  document.getElementById("dcBtnCancel").addEventListener("click", hideDayMenu);
  document.getElementById("dcViewerClose").addEventListener("click", hideViewer);
}

let __pendingDayId = null;

function handleDayTap(dayId) {
  ensureDayMenu();
  __pendingDayId = dayId;

  const overlay = document.getElementById("dcDayOverlay");
  const title = document.getElementById("dcDayTitle");
  const btnView = document.getElementById("dcBtnView");
  const btnTake = document.getElementById("dcBtnTake");
  const btnMood = document.getElementById("dcBtnMood");

  title.textContent = `Options for ${dayId}`;

  const data = monthCache.get(dayId) || {};
  const hasAny = !!(data.husbandUrl || data.wifeUrl);

  btnView.style.display = hasAny ? "inline-block" : "none";

  // Rebind (simple + safe)
  btnTake.onclick = async () => {
    hideDayMenu();
    await openCameraForDay(__pendingDayId);
  };
  btnView.onclick = () => {
    hideDayMenu();
    openViewer(__pendingDayId, data);
  };

  if (btnMood) {
    btnMood.onclick = () => {
      hideDayMenu();
      openMoodViewer(__pendingDayId, data);
    };
  }

  overlay.classList.add("show");
}

function hideDayMenu() {
  const overlay = document.getElementById("dcDayOverlay");
  if (overlay) overlay.classList.remove("show");
}

function openViewer(dayId, data) {
  ensureDayMenu();
  const viewer = document.getElementById("dcViewer");
  const vTitle = document.getElementById("dcViewerTitle");
  const body = document.getElementById("dcViewerBody");
  vTitle.textContent = `Photos for ${dayId}`;

  const parts = [];
  if (data.husbandUrl) {
    parts.push(`<div class="dc-label">Husband</div><img class="dc-img" src="${data.husbandUrl}" alt="Husband photo for ${dayId}">`);
  }
  if (data.wifeUrl) {
    parts.push(`<div class="dc-label">Wife</div><img class="dc-img" src="${data.wifeUrl}" alt="Wife photo for ${dayId}">`);
  }
  if (!parts.length) {
    parts.push(`<div style="opacity:.85;">No photo saved for this day yet.</div>`);
  }

  // Notes
  const mineKey = activeRole === "husband" ? "husbandNote" : "wifeNote";
  const theirsKey = activeRole === "husband" ? "wifeNote" : "husbandNote";
  const mineLabel = activeRole === "husband" ? "Husband note" : "Wife note";
  const theirsLabel = activeRole === "husband" ? "Wife note" : "Husband note";

  body.innerHTML = `
    <div class="dc-viewer-stack">
      ${parts.join("")}
      <div class="dc-notes">
        <div class="dc-notes-grid">
          <div class="dc-note-card">
            <div class="dc-note-title">${mineLabel} (private)</div>
            <textarea id="dcNoteMine" class="dc-note-input" rows="4" placeholder="Write something for this day..."></textarea>
            <div class="dc-note-actions">
              <button id="dcNoteSave" type="button" class="btn">Save note</button>
              <span id="dcNoteSaved" class="dc-note-saved"></span>
            </div>
          </div>
          <div class="dc-note-card">
            <div class="dc-note-title">${theirsLabel} (private)</div>
            <div id="dcNoteTheirs" class="dc-note-readonly muted">No note yet.</div>
          </div>
        </div>
        <div class="dc-note-help muted">Notes are stored per day and per person. Husband can only edit the Husband note; Wife can only edit the Wife note.</div>
      </div>
    </div>
  `;

  // Populate note values safely
  const mineEl = document.getElementById("dcNoteMine");
  const theirsEl = document.getElementById("dcNoteTheirs");
  if (mineEl) mineEl.value = (data[mineKey] || "");
  if (theirsEl) {
    const t = (data[theirsKey] || "").trim();
    theirsEl.textContent = t ? t : "No note yet.";
  }

  // Save handler
  const saveBtn = document.getElementById("dcNoteSave");
  const savedEl = document.getElementById("dcNoteSaved");
  if (saveBtn && mineEl) {
    saveBtn.onclick = async () => {
      try{
        saveBtn.disabled = true;
        if (savedEl) savedEl.textContent = "Saving...";
        await saveNoteForDay(dayId, activeRole, mineEl.value);
        if (savedEl) savedEl.textContent = "Saved ✓";
        // update local cache so reopening reflects immediately
        const cached = monthCache.get(dayId) || {};
        cached[mineKey] = mineEl.value;
        monthCache.set(dayId, cached);
        setTimeout(() => { if (savedEl) savedEl.textContent = ""; }, 1200);
      }catch(e){
        console.error(e);
        if (savedEl) savedEl.textContent = "Could not save";
      }finally{
        saveBtn.disabled = false;
      }
    };
  }

  viewer.classList.add("show");
}

function hideViewer() {
  const viewer = document.getElementById("dcViewer");
  if (viewer) viewer.classList.remove("show");
}


// -------------------- Mood / Sleep Emoji Viewer --------------------
function ensureMoodViewer() {
  if (document.getElementById("moodOverlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "moodOverlay";
  overlay.className = "dc-overlay";
  overlay.style.display = "none";

  overlay.innerHTML = `
    <div class="dc-view" role="dialog" aria-modal="true">
      <div class="dc-view-header">
        <div class="dc-view-title" id="moodTitle">Sleep Emoji Mood</div>
        <button class="dc-close" id="moodCloseBtn" aria-label="Close">✕</button>
      </div>

      <div class="dc-view-body">
        <div class="mood-grid">
          <div class="mood-card">
            <div class="mood-card-title">Husband mood</div>
            <div class="mood-selected" id="moodHSelected">—</div>
            <div class="mood-picker" id="moodHPicker"></div>
            <textarea id="moodHText" class="mood-text" rows="2" placeholder="Optional note..."></textarea>
            <button id="moodHSave" class="dc-btn dc-btn-primary">Save mood</button>
            <div class="mood-hint" id="moodHHint"></div>
          </div>

          <div class="mood-card">
            <div class="mood-card-title">Wife mood</div>
            <div class="mood-selected" id="moodWSelected">—</div>
            <div class="mood-picker" id="moodWPicker"></div>
            <textarea id="moodWText" class="mood-text" rows="2" placeholder="Optional note..."></textarea>
            <button id="moodWSave" class="dc-btn dc-btn-primary">Save mood</button>
            <div class="mood-hint" id="moodWHint"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const close = () => hideMoodViewer();
  document.getElementById("moodCloseBtn").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
}

function hideMoodViewer() {
  const overlay = document.getElementById("moodOverlay");
  if (!overlay) return;
  overlay.style.display = "none";
}

async function saveMoodForDay(dayId, role, emoji, text) {
  const dayRef = doc(db, "rooms", roomId, "days", dayId);
  const payload = {};
  if (role === "husband") {
    payload.mood_husband_emoji = emoji || "";
    payload.mood_husband_text = text || "";
  } else {
    payload.mood_wife_emoji = emoji || "";
    payload.mood_wife_text = text || "";
  }
  await setDoc(dayRef, payload, { merge: true });
}

function openMoodViewer(dayId, data = {}) {
  ensureMoodViewer();

  const overlay = document.getElementById("moodOverlay");
  const title = document.getElementById("moodTitle");
  title.textContent = `Sleep Emoji Mood — ${dayId}`;

  const emojis = ["😴","😊","😐","😣","😢","😡","🤒","🥱","💪","🥰"];

  const cards = [
    {
      role: "husband",
      selectedEl: document.getElementById("moodHSelected"),
      pickerEl: document.getElementById("moodHPicker"),
      textEl: document.getElementById("moodHText"),
      saveBtn: document.getElementById("moodHSave"),
      hintEl: document.getElementById("moodHHint"),
      keyEmoji: "mood_husband_emoji",
      keyText: "mood_husband_text",
    },
    {
      role: "wife",
      selectedEl: document.getElementById("moodWSelected"),
      pickerEl: document.getElementById("moodWPicker"),
      textEl: document.getElementById("moodWText"),
      saveBtn: document.getElementById("moodWSave"),
      hintEl: document.getElementById("moodWHint"),
      keyEmoji: "mood_wife_emoji",
      keyText: "mood_wife_text",
    }
  ];

  cards.forEach((card) => {
    let selected = (data && data[card.keyEmoji]) ? data[card.keyEmoji] : "";
    card.selectedEl.textContent = selected || "—";
    card.textEl.value = (data && data[card.keyText]) ? data[card.keyText] : "";

    card.pickerEl.innerHTML = "";
    emojis.forEach((e) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mood-emoji";
      b.textContent = e;
      b.onclick = () => {
        selected = e;
        card.selectedEl.textContent = e;
      };
      card.pickerEl.appendChild(b);
    });

    const canEdit = (activeRole === card.role);
    card.textEl.disabled = !canEdit;
    card.saveBtn.disabled = !canEdit;
    card.pickerEl.classList.toggle("mood-disabled", !canEdit);
    card.hintEl.textContent = canEdit ? "" : `Only ${card.role === "husband" ? "Husband" : "Wife"} can edit this.`;

    card.saveBtn.onclick = async () => {
      try {
        await saveMoodForDay(dayId, card.role, selected, card.textEl.value.trim());
        toast("Mood saved 😴");
        if (data) {
          data[card.keyEmoji] = selected || "";
          data[card.keyText] = card.textEl.value.trim();
        }
      } catch (err) {
        console.error(err);
        toast("Could not save mood.");
      }
    };
  });

  overlay.style.display = "flex";
}



cameraInput.addEventListener("change", async () => {
  const file = cameraInput.files?.[0];
  if (!file || !pendingDayId) return;
  const dayId = pendingDayId;
  pendingDayId = null;

  // Double-check auth here as well (mobile Safari can dispatch this quickly).
  if (auth && !auth.currentUser) {
    try {
      await Promise.race([
        authReady,
        new Promise((_, rej) => setTimeout(() => rej(new Error("auth-timeout")), 6000))
      ]);
    } catch (_) {
      alert("Still connecting to Firebase. Please wait a second and try again.");
      return;
    }
  }

  try{
    setStatus(false, "Uploading…");
    const compressed = await compressImage(file);
    const objRef = sRef(storage, storagePath(activeRole, dayId));
    await uploadBytes(objRef, compressed, { contentType: "image/jpeg" });
    const url = await getDownloadURL(objRef);

    const payload = {
      dayId,
      updatedAt: serverTimestamp(),
      ...(activeRole === "husband"
        ? { husbandUrl: url, husbandUpdatedAt: serverTimestamp() }
        : { wifeUrl: url, wifeUpdatedAt: serverTimestamp() }
      )
    };

    await setDoc(dayDoc(dayId), payload, { merge: true });
    setStatus(true, "Saved ✅");
  } catch(e){
    console.error(e);
    setStatus(false, "Upload failed");
    alert("Upload failed. Check Firebase setup + rules.");
  }
});

renderCalendar();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

let deferredPrompt = null;
const installBox = document.getElementById("installBox");
const installBtn = document.getElementById("installBtn");

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (installBox) installBox.style.display = "block";
});

if (installBtn) {
  installBtn.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    if (installBox) installBox.style.display = "none";
  });
}

if (auth) {
  setStatus(false, "Connecting…");
  signInAnonymously(auth).catch((err) => {
    console.error(err);
    setStatus(false, "Auth error (enable Anonymous)");
  });
  onAuthStateChanged(auth, (user) => {
    if (!user) return;
    // Unblock actions that require authenticated Storage writes (mobile can be slower).
    try { _resolveAuthReady && _resolveAuthReady(); } catch(_) {}
    setStatus(true, "Online");
    attachMonthListener();
    attachStreakListener();
  });
}


// Floating hearts (visual only)
const heartsLayer = document.getElementById("heartsLayer");
if (heartsLayer) {
  const EMOJIS = ["💜","💖","💘","💝","💗","💕","💞","❤️","🩷","🩵","💟","💋"];
  const prefersReduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!prefersReduced) {
    const maxOnScreen = 70; // keep it light on phones
    function spawnHeart() {
      if (!document.body.contains(heartsLayer)) return;
      if (heartsLayer.childElementCount > maxOnScreen) {
        // remove a few oldest
        for (let i = 0; i < 8 && heartsLayer.firstChild; i++) heartsLayer.removeChild(heartsLayer.firstChild);
      }
      const el = document.createElement("div");
      el.className = "heart";
      el.textContent = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
      const x = Math.random() * 100;
      const size = 14 + Math.random() * 22; // px
      const duration = 6.5 + Math.random() * 6.5; // seconds
      const drift = (Math.random() * 140 - 70).toFixed(0) + "px";
      const spin = (Math.random() * 360 - 180).toFixed(0) + "deg";
      el.style.left = x + "vw";
      el.style.fontSize = size + "px";
      el.style.animationDuration = duration + "s";
      el.style.setProperty("--drift", drift);
      el.style.setProperty("--spin", spin);
      heartsLayer.appendChild(el);
      el.addEventListener("animationend", () => el.remove());
    }
    // lots dropping, but adaptive
    let baseInterval = 380; // ms
    if (window.innerWidth < 520) baseInterval = 520;
    setInterval(() => {
      // burst occasionally
      const burst = Math.random() < 0.18 ? 3 : 1;
      for (let i=0;i<burst;i++) spawnHeart();
    }, baseInterval);
  }
}


// Rotating love poems (500 unique lines, random start)
(function(){
  const el = document.getElementById("lovePoem");
  if (!el) return;
  const prefersReduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function generatePoems(n=500){
    // Build 500 unique "micro-poems" from combinations (no copyrighted text).
    const openers = [
      "My love,",
      "Sweetheart,",
      "Darling,",
      "To my wife,",
      "Every day,",
      "In quiet moments,",
      "When the world is loud,",
      "In your smile,",
      "In your eyes,",
      "In your laugh,"
    ];
    const middles = [
      "you make home feel like a heartbeat.",
      "you turn ordinary minutes into memories.",
      "I find peace I didn’t know I needed.",
      "I remember what gratitude feels like.",
      "my chest feels lighter and my soul feels fuller.",
      "I want to keep choosing you—again and again.",
      "I’m proud of you, always.",
      "I see you, and I’m thankful.",
      "I’m still amazed you’re mine.",
      "I love the way you are."
    ];
    const closers = [
      "I’m here, today and tomorrow.",
      "Let’s keep growing together.",
      "Thank you for being you.",
      "You’re my favorite promise.",
      "You are my safest place.",
      "I love you more than words can hold.",
      "I choose you—every single day.",
      "You make my life softer and brighter.",
      "With you, I feel brave.",
      "Forever starts again, today."
    ];
    const sweetBits = [
      "💜",
      "💖",
      "💞",
      "❤️",
      "💝",
      "💕",
      "💗",
      "🫶",
      "✨",
      "🌙"
    ];
    const out = [];
    let i = 0;
    while (out.length < n){
      const a = openers[i % openers.length];
      const b = middles[(i * 3) % middles.length];
      const c = closers[(i * 7) % closers.length];
      const d = sweetBits[(i * 11) % sweetBits.length];
      const line = `${a} ${b} ${c} ${d}`;
      out.push(line);
      i++;
    }
    // Ensure uniqueness (they already are by index), but keep safe:
    return out.slice(0, n);
  }

  const poems = generatePoems(500);
  let idx = Math.floor(Math.random() * poems.length); // random start every load

  function show(){
        // fade out -> swap text -> fade in
        el.classList.add("isFading");
        window.setTimeout(() => {
          el.textContent = poems[idx];
          idx = (idx + 1) % poems.length;
          el.classList.remove("isFading");
        }, 350);
      }
  show();
  if (!prefersReduced){
    setInterval(show, 10000); // rotate every 10 seconds
  }
})();


// ---------------- Notifications (Web Push) ----------------
let __toastEl = null;
function toast(msg){
  try{
    if (!__toastEl){
      __toastEl = document.createElement("div");
      __toastEl.className = "toast";
      document.body.appendChild(__toastEl);
    }
    __toastEl.textContent = msg;
    __toastEl.classList.add("show");
    setTimeout(() => __toastEl && __toastEl.classList.remove("show"), 2800);
  } catch(_) {}
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

// TODO: paste your VAPID public key here (generated during setup)
const VAPID_PUBLIC_KEY = "BEG0-7YwjD4AtjJewIfmeRWkThrVMCdPy0RQiC7q1upHBfKFUpl5uEQtlbgwk6jTVJF6ji4tCa-zvwJ4s1qJDSU";

function getDeviceId(){
  let id = localStorage.getItem("cc_device_id");
  if (!id){
    id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + "_" + Math.random().toString(16).slice(2);
    localStorage.setItem("cc_device_id", id);
  }
  return id;
}

async function enablePushNotifications(){
  if (!cfg || !ROOM_ID){
    toast("Finish Setup first, then enable notifications.");
    return;
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in window)){
    toast("Push not supported on this device.");
    return;
  }
  if (!VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY.includes("PASTE_")){
    toast("VAPID key not set yet (needs setup).");
    return;
  }

  try{
    const perm = await Notification.requestPermission();
    if (perm !== "granted"){
      toast("Notifications not enabled.");
      return;
    }

    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });

    await authReady;
    if (!activeRole) { throw new Error('Role not set'); }
    const deviceId = getDeviceId();
    const docId = `${activeRole}_${deviceId}`;
    const subRef = doc(db, "rooms", ROOM_ID, "pushSubs", docId);
    await setDoc(subRef, {
      role: (activeRole || "").toLowerCase(),
      roleLabel: activeRole,
      deviceId,
      subscription: sub.toJSON(),
      updatedAt: serverTimestamp(),
      userAgent: navigator.userAgent || "",
    }, { merge: true });

    toast("Notifications enabled ✅");
  } catch(e){
    console.error(e);
    toast("Couldn’t enable notifications. Check Firestore rules for pushSubs.");
    try{alert("Couldn’t enable notifications. This is usually Firestore rules blocking writes to /rooms/"+ROOM_ID+"/pushSubs.\n\nError: "+(e && e.message ? e.message : e));}catch(_){}
  }
}

if (notifBtn){
  notifBtn.addEventListener("click", enablePushNotifications);
}
