const MedicineReminder = require("../models/MedicineReminder");
const NotificationLog = require("../models/NotificationLog");
const PatientUser = require("../models/PatientUser");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { sendPushNotification } = require("../utils/pushNotifications");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Return start-of-day and end-of-day Date objects for today (UTC).
 */
const todayRange = () => {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
};

// ─── Controllers ──────────────────────────────────────────────────────────────

/**
 * GET /admin/reminders/stats
 * Aggregate dashboard statistics for medicine reminders and notifications.
 */
exports.getReminderStats = catchAsync(async (req, res) => {
  const { start, end } = todayRange();

  const [activeReminders, sentToday, failedToday, unreadTotal] = await Promise.all([
    MedicineReminder.countDocuments({ status: "active" }),
    NotificationLog.countDocuments({ createdAt: { $gte: start, $lt: end }, status: "sent" }),
    NotificationLog.countDocuments({ createdAt: { $gte: start, $lt: end }, status: "failed" }),
    NotificationLog.countDocuments({ isRead: false }),
  ]);

  res.status(200).json({
    success: true,
    data: {
      activeReminders,
      notificationsSentToday: sentToday,
      notificationsFailedToday: failedToday,
      unreadNotifications: unreadTotal,
    },
  });
});

/**
 * GET /admin/reminders/logs
 * Paginated notification logs with patient name/email populated.
 */
exports.getNotificationLogs = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const skip = (page - 1) * limit;

  const [logs, total] = await Promise.all([
    NotificationLog.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("patientUserId", "name email")
      .lean(),
    NotificationLog.countDocuments(),
  ]);

  res.status(200).json({
    success: true,
    data: logs,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

/**
 * POST /admin/reminders/resend/:logId
 * Resend a previously failed push notification.
 */
exports.resendNotification = catchAsync(async (req, res) => {
  const log = await NotificationLog.findById(req.params.logId);

  if (!log) {
    throw new AppError("Notification log entry not found.", 404);
  }

  if (log.status !== "failed") {
    throw new AppError("Only failed notifications can be resent.", 400);
  }

  const patient = await PatientUser.findById(log.patientUserId).select("fcmToken name").lean();

  if (!patient) {
    throw new AppError("Patient user not found.", 404);
  }

  if (!patient.fcmToken) {
    throw new AppError("Patient does not have a registered FCM token.", 400);
  }

  try {
    const response = await sendPushNotification(patient.fcmToken, {
      title: log.title,
      body: log.body,
      data: {
        category: log.category,
        actionUrl: log.actionUrl || "/dashboard",
        reminderId: log.reminderId ? String(log.reminderId) : "",
      },
    });

    log.status = "sent";
    log.sentAt = new Date();
    log.fcmMessageId = (response && typeof response === "object" ? response.messageId : response) || null;
    log.errorMessage = null;
    await log.save();
  } catch (error) {
    log.errorMessage = error.message || "Resend failed";
    await log.save();
    throw new AppError("Failed to resend notification. See log for details.", 500);
  }

  res.status(200).json({ success: true, data: log });
});
