const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
const webpush = require("web-push");

admin.initializeApp();

function configureWebPush() {
  const cfg = functions.config();
  const vapidPublic = cfg.vapid && cfg.vapid.public;
  const vapidPrivate = cfg.vapid && cfg.vapid.private;
  const subject = (cfg.vapid && cfg.vapid.subject) || "mailto:you@example.com";
  if (!vapidPublic || !vapidPrivate) {
    throw new Error("Missing VAPID keys. Set via: firebase functions:config:set vapid.public=... vapid.private=... vapid.subject=mailto:...");
  }
  webpush.setVapidDetails(subject, vapidPublic, vapidPrivate);
}

exports.notifyOnCheckin = functions.firestore
  .document("rooms/{roomId}/days/{dayId}")
  .onWrite(async (change, context) => {
    const after = change.after.exists ? change.after.data() : null;
    const before = change.before.exists ? change.before.data() : null;
    if (!after) return null;

    const prevH = before ? before.husbandUrl : null;
    const prevW = before ? before.wifeUrl : null;
    const nextH = after.husbandUrl || null;
    const nextW = after.wifeUrl || null;

    let actor = null;
    if (!prevH && nextH) actor = "husband";
    if (!prevW && nextW) actor = "wife";
    if (!actor) return null;

    const targetRole = actor === "husband" ? "wife" : "husband";
    const roomId = context.params.roomId;
    const dayId = after.dayId || context.params.dayId;

    const subsSnap = await admin.firestore()
      .collection("rooms").doc(roomId)
      .collection("pushSubs")
      .where("role", "==", targetRole)
      .get();

    if (subsSnap.empty) return null;

    configureWebPush();

    const payload = JSON.stringify({
      title: "Daily Check‑In",
      body: `${actor === "husband" ? "Husband" : "Wife"} checked in for ${dayId} 💜`,
      url: "./"
    });

    const sends = [];
    for (const doc of subsSnap.docs) {
      const d = doc.data() || {};
      const sub = d.subscription;
      if (!sub) continue;
      sends.push(
        webpush.sendNotification(sub, payload).catch(async (err) => {
          if (err && (err.statusCode === 404 || err.statusCode === 410)) {
            await doc.ref.delete().catch(() => {});
          } else {
            console.error("Push send failed:", err);
          }
        })
      );
    }

    await Promise.allSettled(sends);
    return null;
  });
