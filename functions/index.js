/**
 * Daily Check‑In push notifications (Firebase Functions v2 + Secret Manager).
 * - Trigger: rooms/{roomId}/days/{dayId} (write)
 * - Sends a push to the partner who HASN'T checked in yet (for TODAY only).
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

// Keep region consistent with your existing function (you were using us-central1).
const REGION = "us-central1";

// --- Helpers ---
function todayIdUTC() {
  // Firestore doc ids are YYYY-MM-DD in this project.
  return new Date().toISOString().slice(0, 10);
}

function safeStr(v) {
  return typeof v === "string" ? v : "";
}

function configureWebPush() {
  const pub = safeStr(VAPID_PUBLIC.value());
  const priv = safeStr(VAPID_PRIVATE.value());
  const subj = safeStr(VAPID_SUBJECT.value()) || "mailto:you@example.com";

  if (!pub || !priv) {
    // Keep the old, familiar error so it’s obvious what’s missing.
    throw new Error(
      "Missing VAPID keys. Set secrets VAPID_PUBLIC / VAPID_PRIVATE / VAPID_SUBJECT."
    );
  }
  webpush.setVapidDetails(subj, pub, priv);
}

function buildPayload({ title, body, roomId, dayId }) {
  // Keep payload simple + compatible with your service worker.
  return JSON.stringify({
    title,
    body,
    roomId,
    dayId,
    // Open the app root; the client already knows how to navigate from there.
    url: "./",
  });
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

    // Only notify for today's check-in (prevents past/future testing noise).
    if (dayId !== todayIdUTC()) return;

    const change = event.data;
    if (!change) return;

    const beforeExists = change.before && change.before.exists;
    const afterExists = change.after && change.after.exists;
    if (!afterExists) return; // deleted doc

    const before = beforeExists ? change.before.data() : {};
    const after = change.after.data() || {};

    // Your app stores photo URLs like husbandUrl / wifeUrl.
    const beforeH = safeStr(before.husbandUrl);
    const beforeW = safeStr(before.wifeUrl);
    const afterH = safeStr(after.husbandUrl);
    const afterW = safeStr(after.wifeUrl);

    // Detect "new check-in" events (a URL appears or changes to a new non-empty value).
    const husbandJustCheckedIn = afterH && afterH !== beforeH;
    const wifeJustCheckedIn = afterW && afterW !== beforeW;

    // If both updated in same write, don't notify (both already checked in).
    if (husbandJustCheckedIn && wifeJustCheckedIn) return;

    // Determine who to notify (the partner who has NOT checked in yet).
    let notifyRole = null;
    let title = null;
    let body = null;

    if (husbandJustCheckedIn && !afterW) {
      notifyRole = "wife";
      title = "💗 Husband checked in";
      body = "Your husband just checked in for today. Tap to see the photo.";
    } else if (wifeJustCheckedIn && !afterH) {
      notifyRole = "husband";
      title = "💗 Wife checked in";
      body = "Your wife just checked in for today. Tap to see the photo.";
    } else {
      // Either not a relevant change, or the other partner already checked in.
      return;
    }

    configureWebPush();

    // Grab subscriptions for the other role.
    const subsSnap = await admin
      .firestore()
      .collection("rooms")
      .doc(roomId)
      .collection("pushSubs")
      .where("role", "==", notifyRole)
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
);
