const admin = require("firebase-admin");

let fcmInitialized = false;

try {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (serviceAccountJson) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(serviceAccountJson);
    } catch (parseErr) {
      // If it's a string representation containing escaped characters, try cleaning it
      console.warn("[FCM] Failed to parse FIREBASE_SERVICE_ACCOUNT as direct JSON. Trying string cleaning...", parseErr);
      const cleaned = serviceAccountJson.replace(/\\n/g, "\n").replace(/^'|'$/g, "");
      serviceAccount = JSON.parse(cleaned);
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    fcmInitialized = true;
    console.log("[FCM] Firebase Admin SDK initialized successfully.");
  } else {
    console.warn("[FCM] FIREBASE_SERVICE_ACCOUNT environment variable is not defined. Push notifications will be mocked.");
  }
} catch (err) {
  console.error("[FCM] Firebase Admin SDK initialization failed:", err);
}

/**
 * Remove an invalid/unregistered FCM token from the database.
 * 
 * @param {string} invalidToken - The invalid registration token
 */
const removeInvalidToken = async (invalidToken) => {
  try {
    const PatientUser = require("../models/PatientUser");
    await PatientUser.updateMany(
      { fcmTokens: invalidToken },
      { $pull: { fcmTokens: invalidToken } }
    );
    await PatientUser.updateOne(
      { fcmToken: invalidToken },
      { $set: { fcmToken: null } }
    );
    console.log(`[FCM] Unregistered/invalid token removed from DB: ${invalidToken.substring(0, 10)}...`);
  } catch (dbErr) {
    console.error("[FCM] Error removing invalid token from database:", dbErr);
  }
};

/**
 * Send a push notification via Firebase Cloud Messaging.
 * Falls back to console log if Firebase is not initialized.
 * 
 * For medicine reminders, a dedicated high-priority alarm channel is used with:
 *  - android.priority = "high" (HEAD OF QUEUE delivery)
 *  - android.notification.channelId = "medicine_alarm_channel"
 *  - android.notification.defaultSound = false (channel manages sound)
 *  - android.notification.notificationPriority = PRIORITY_MAX
 *  - apns content-available = 1 for iOS background wakeup
 * 
 * @param {string} fcmToken - The target device registration token
 * @param {object} payload - { title, body, data }
 */
const sendPushNotification = async (fcmToken, { title, body, data }) => {
  if (!fcmToken) {
    console.warn("[FCM] Attempted to send notification but no FCM token was provided.");
    return;
  }

  // 1. Resolve all tokens for the user to support multi-device delivery
  let tokensToSend = [fcmToken];
  try {
    const PatientUser = require("../models/PatientUser");
    const patient = await PatientUser.findOne({
      $or: [
        { fcmToken: fcmToken },
        { fcmTokens: fcmToken }
      ]
    }).lean();

    if (patient && patient.fcmTokens && patient.fcmTokens.length > 0) {
      tokensToSend = patient.fcmTokens;
    }
  } catch (err) {
    console.error("[FCM] Error resolving patient tokens from DB:", err);
  }

  const isMedicine = data && (
    data.type === "medicine_reminder" ||
    data.category === "medicine_reminder" ||
    data.channelId === "medicine_channel" ||
    data.channelId === "medicine_channel_v2" ||
    data.channelId === "medicine_channel_v3" ||
    data.channelId === "medicine_alarm_channel" ||
    data.channel_id === "medicine_channel" ||
    data.channel_id === "medicine_channel_v2" ||
    data.channel_id === "medicine_channel_v3" ||
    data.channel_id === "medicine_alarm_channel"
  );

  const finalData = data ? { ...data } : {};
  if (isMedicine) {
    finalData.category = "medicine_reminder";
    // medicine_alarm_channel: IMPORTANCE_HIGH + custom alarm sound on Android
    finalData.channelId = "medicine_alarm_channel";
    finalData.channel_id = "medicine_alarm_channel";
    finalData.sound = "medicine_alarm";
    if (!finalData.type) finalData.type = "medicine_reminder";
  } else {
    finalData.channelId = "default_channel_v2";
    if (!finalData.channel_id) finalData.channel_id = "default_channel_v2";
  }

  // All FCM data values must be strings
  const fcmData = Object.keys(finalData).reduce((acc, key) => {
    acc[key] = String(finalData[key]);
    return acc;
  }, {});

  // ── Android config ──────────────────────────────────────────────
  // NOTE: For data-only messages the android.notification block is ignored.
  // Only android.priority matters — "high" bypasses Android Doze mode and
  // wakes the device so onMessageReceived fires even on a locked screen.
  const androidConfig = isMedicine
    ? {
        priority: "high",   // HIGH priority — delivers even in Doze mode
        restrictedPackageName: undefined, // let all devices receive
      }
    : {
        priority: "normal",
      };

  // ── APNS (iOS) config ────────────────────────────────────────
  const apnsConfig = isMedicine
    ? {
        payload: {
          aps: {
            "content-available": 1,          // wakes iOS app in background
            "sound": "medicine_alarm.caf",
            "interruption-level": "time-sensitive",
          },
        },
        headers: {
          "apns-priority": "10",
          "apns-push-type": "background",
        },
      }
    : {};

  console.log(`[FCM] Resolving send multicast for ${tokensToSend.length} tokens.`);
  let responses = [];

  if (fcmInitialized) {
    // ── CRITICAL: DATA-ONLY payload (no top-level 'notification' key) ──────
    // If a 'notification' key is present, Android Firebase SDK bypasses
    // onMessageReceived entirely when the app is in background or closed,
    // showing a generic system notification instead of our alarm.
    // Data-only messages guarantee onMessageReceived fires in ALL app states.
    const multicastMessage = {
      tokens: tokensToSend,
      // NO notification key here — data-only ensures MyFirebaseMessagingService
      // always handles the display with the correct alarm channel and sound.
      data: {
        ...fcmData,
        // Embed title and body inside data so our native service can read them
        title: String(title || "MedKwik HealthBuddy"),
        body:  String(body  || "You have a new notification."),
      },
      android: androidConfig,
      apns: apnsConfig,
    };

    try {
      const batchResponse = await admin.messaging().sendEachForMulticast(multicastMessage);
      console.log("[FCM] Multicast Batch Response:", JSON.stringify(batchResponse));

      responses = batchResponse.responses.map((resp, index) => {
        const token = tokensToSend[index];
        if (resp.success) {
          console.log(`[FCM] Successfully sent push notification to token ${token.substring(0, 10)}...:`, resp.messageId);
          return resp.messageId;
        } else {
          const err = resp.error;
          const isStaleToken =
            err &&
            (
              err.code === "messaging/invalid-argument" ||
              err.code === "messaging/registration-token-not-registered"
            );

          if (isStaleToken) {
            // Expected: user uninstalled app or token rotated — clean up silently
            console.warn(`[FCM] Stale token removed ${token.substring(0, 10)}...: ${err.code}`);
            removeInvalidToken(token);
          } else {
            // Unexpected error — log as error
            console.error(`[FCM] Error sending push notification to token ${token.substring(0, 10)}...:`, err);
          }
          return null;
        }
      });
    } catch (err) {
      console.error("[FCM] Fatal error during sendEachForMulticast:", err);
      throw err;
    }
  } else {
    responses = tokensToSend.map((token) => {
      const mockResponse = `mock-msg-id-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
      console.log("Firebase Response:", mockResponse);
      console.log("[FCM] [MOCK SEND] Push Notification details:", {
        fcmToken: token,
        title,
        body,
        data: fcmData,
        android: androidConfig,
      });
      return mockResponse;
    });
  }
  const validMessageIds = responses.filter(Boolean);
  const messageIdString = validMessageIds.length > 0 ? validMessageIds.join(",") : null;
  return { messageId: messageIdString };
};

module.exports = {
  sendPushNotification,
  isFcmInitialized: () => fcmInitialized,
};
