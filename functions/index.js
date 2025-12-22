/**
 * Daily Check‑In push notifications (Firebase Functions v2 + Secret Manager).
 * - Trigger: rooms/{roomId}/days/{dayId} (write)
 * - Sends push notifications for TODAY when:
 *    1) A photo is uploaded/changed (husbandUrl or wifeUrl changes) -> notify the other person EVERY time.
 *    2) A Daily Note is saved (husbandNote / wifeNote changes)      -> notify the other person.
 *    3) Sleep Mood is saved (mood_* fields change)                  -> notify the other person.
 *
 * Required secrets (Firebase Secret Manager):
 *   VAPID_PUBLIC
 *   VAPID_PRIVATE
 *   VAPID_SUBJECT   (e.g. "mailto:you@example.com")
 */
const admin = require("firebase-admin");
const webpush = require("web-push");

const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");

admin.initializeApp();

// Secrets (set with: firebase functions:secrets:set VAPID_PUBLIC, etc.)
const VAPID_PUBLIC = defineSecret("VAPID_PUBLIC");
const VAPID_PRIVATE = defineSecret("VAPID_PRIVATE");
const VAPID_SUBJECT = defineSecret("VAPID_SUBJECT");

// Keep region consistent with your existing function.
const REGION = "us-central1";

// --- Helpers ---
function todayIdUTC() {
  // Firestore doc ids are YYYY-MM-DD in this project.
  return new Date().toISOString().slice(0, 10);
}

function safeStr(v) {
  return typeof v === "string" ? v : "";
}

function normalizeSecret(v) {
  // Firebase secrets can include trailing newlines when set via redirected files.
  // Trim whitespace and strip surrounding quotes so web-push gets clean keys.
  const s = safeStr(v).trim();
  return s.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
}

function configureWebPush() {
  const pub = normalizeSecret(VAPID_PUBLIC.value());
  const priv = normalizeSecret(VAPID_PRIVATE.value());
  const subj = normalizeSecret(VAPID_SUBJECT.value()) || "mailto:you@example.com";

  if (!pub || !priv) {
    throw new Error(
      "Missing VAPID keys. Set secrets VAPID_PUBLIC / VAPID_PRIVATE / VAPID_SUBJECT."
    );
  }
  webpush.setVapidDetails(subj, pub, priv);
}

function buildPayload({ title, body, roomId, dayId }) {
  return JSON.stringify({
    title,
    body,
    roomId,
    dayId,
    url: "./",
  });
}

async function sendToRole({ roomId, dayId, role, title, body }) {
  const subsSnap = await admin
    .firestore()
    .collection("rooms")
    .doc(roomId)
    .collection("pushSubs")
    .where("role", "==", role)
    .get();

  if (subsSnap.empty) return;

  const payload = buildPayload({ title, body, roomId, dayId });

  const sends = [];
  subsSnap.forEach((doc) => {
    const data = doc.data() || {};
    const sub = data.subscription;
    if (!sub) return;

    sends.push(
      webpush.sendNotification(sub, payload).catch(async (err) => {
        // Clean up dead subscriptions
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          await doc.ref.delete().catch(() => {});
        } else {
          console.error("Push send failed:", err);
        }
      })
    );
  });

  await Promise.allSettled(sends);
}

// --- Main function ---
exports.notifyOnCheckinV2 = onDocumentWritten(
  {
    document: "rooms/{roomId}/days/{dayId}",
    region: REGION,
    secrets: [VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT],
  },
  async (event) => {
    const roomId = event.params.roomId;
    const dayId = event.params.dayId;

    // Keep it calm: only notify for TODAY (prevents old-day edits from spamming).
    if (dayId !== todayIdUTC()) return;

    const change = event.data;
    if (!change) return;

    const beforeExists = change.before && change.before.exists;
    const afterExists = change.after && change.after.exists;
    if (!afterExists) return; // deleted doc

    const before = beforeExists ? change.before.data() : {};
    const after = change.after.data() || {};

    // --- Photos ---
    const beforeHUrl = safeStr(before.husbandUrl);
    const beforeWUrl = safeStr(before.wifeUrl);
    const afterHUrl = safeStr(after.husbandUrl);
    const afterWUrl = safeStr(after.wifeUrl);

    const husbandPhotoChanged = !!(afterHUrl && afterHUrl !== beforeHUrl);
    const wifePhotoChanged = !!(afterWUrl && afterWUrl !== beforeWUrl);

    // --- Notes (Daily Note modal saves these keys) ---
    const beforeHNote = safeStr(before.husbandNote);
    const beforeWNote = safeStr(before.wifeNote);
    const afterHNote = safeStr(after.husbandNote);
    const afterWNote = safeStr(after.wifeNote);

    const husbandNoteChanged = afterHNote !== beforeHNote;
    const wifeNoteChanged = afterWNote !== beforeWNote;

    // --- Sleep Mood ---
    const beforeHMoodE = safeStr(before.mood_husband_emoji);
    const beforeWMoodE = safeStr(before.mood_wife_emoji);
    const afterHMoodE = safeStr(after.mood_husband_emoji);
    const afterWMoodE = safeStr(after.mood_wife_emoji);

    const beforeHMoodT = safeStr(before.mood_husband_text);
    const beforeWMoodT = safeStr(before.mood_wife_text);
    const afterHMoodT = safeStr(after.mood_husband_text);
    const afterWMoodT = safeStr(after.mood_wife_text);

    const husbandMoodChanged = (afterHMoodE !== beforeHMoodE) || (afterHMoodT !== beforeHMoodT);
    const wifeMoodChanged = (afterWMoodE !== beforeWMoodE) || (afterWMoodT !== beforeWMoodT);

    // If nothing we care about changed, stop early.
    if (
      !husbandPhotoChanged &&
      !wifePhotoChanged &&
      !husbandNoteChanged &&
      !wifeNoteChanged &&
      !husbandMoodChanged &&
      !wifeMoodChanged
    ) {
      return;
    }

    configureWebPush();

    // Build a list of notifications to send.
    // IMPORTANT: Always notify the OTHER person (even if they already did theirs).
    const sends = [];

    // Photos (same wording every time)
    if (husbandPhotoChanged) {
      sends.push(
        sendToRole({
          roomId,
          dayId,
          role: "wife",
          title: "💗 Husband checked in",
          body: "Your husband just checked in for today. Tap to see the photo.",
        })
      );
    }
    if (wifePhotoChanged) {
      sends.push(
        sendToRole({
          roomId,
          dayId,
          role: "husband",
          title: "💗 Wife checked in",
          body: "Your wife just checked in for today. Tap to see the photo.",
        })
      );
    }

    // Daily Notes
    if (husbandNoteChanged) {
      sends.push(
        sendToRole({
          roomId,
          dayId,
          role: "wife",
          title: "💌 New daily note",
          body: "Your husband wrote you a note for today.",
        })
      );
    }
    if (wifeNoteChanged) {
      sends.push(
        sendToRole({
          roomId,
          dayId,
          role: "husband",
          title: "💌 New daily note",
          body: "Your wife wrote you a note for today.",
        })
      );
    }

    // Sleep Mood
    if (husbandMoodChanged) {
      sends.push(
        sendToRole({
          roomId,
          dayId,
          role: "wife",
          title: "😴 Sleep mood updated",
          body: "Your husband updated his sleep mood for today.",
        })
      );
    }
    if (wifeMoodChanged) {
      sends.push(
        sendToRole({
          roomId,
          dayId,
          role: "husband",
          title: "😴 Sleep mood updated",
          body: "Your wife updated her sleep mood for today.",
        })
      );
    }

    await Promise.allSettled(sends);
  }
);
