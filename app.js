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
  where
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
const storage = app ? getStorage(app) : null;

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
});

monthSel.addEventListener("change", () => {
  viewMonth = Number(monthSel.value);
  renderCalendar();
  attachMonthListener();
});
yearSel.addEventListener("change", () => {
  viewYear = Number(yearSel.value);
  renderCalendar();
  attachMonthListener();
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
    cell.addEventListener("click", () => openCameraForDay(dayId));
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

let pendingDayId = null;
function openCameraForDay(dayId){
  if (!storage || !db) {
    alert("Open Setup and save your Firebase config + Room ID first.");
    return;
  }
  pendingDayId = dayId;
  cameraInput.value = "";
  cameraInput.click();
}

cameraInput.addEventListener("change", async () => {
  const file = cameraInput.files?.[0];
  if (!file || !pendingDayId) return;
  const dayId = pendingDayId;
  pendingDayId = null;

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

if (auth) {
  setStatus(false, "Connecting…");
  signInAnonymously(auth).catch((err) => {
    console.error(err);
    setStatus(false, "Auth error (enable Anonymous)");
  });
  onAuthStateChanged(auth, (user) => {
    if (!user) return;
    attachMonthListener();
  });
}
