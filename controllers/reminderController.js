const MedicineReminder = require("../models/MedicineReminder");
const NotificationLog = require("../models/NotificationLog");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

const TIME_FORMAT = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_TIMES = 8;
const VALID_STATUSES = ["active", "paused", "completed"];
const VALID_REPEAT_TYPES = ["daily", "weekly", "custom_days", "every_x_hours"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Return a Date representing the start of today in UTC.
 */
const startOfTodayUTC = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

/**
 * Return a Date N days ago from now.
 */
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

/**
 * Validate times array — shared between create and update.
 */
const validateTimes = (times) => {
  if (!Array.isArray(times) || times.length === 0) {
    throw new AppError("At least one reminder time is required.", 422);
  }
  if (times.length > MAX_TIMES) {
    throw new AppError(`A maximum of ${MAX_TIMES} reminder times are allowed.`, 422);
  }
  for (const t of times) {
    if (!TIME_FORMAT.test(t)) {
      throw new AppError(`Invalid time format "${t}". Use HH:mm (00:00–23:59).`, 422);
    }
  }
};

/**
 * Validate repeatDays — must be integers 0–6.
 */
const validateRepeatDays = (days) => {
  if (!Array.isArray(days)) throw new AppError("repeatDays must be an array.", 422);
  for (const d of days) {
    if (!Number.isInteger(d) || d < 0 || d > 6) {
      throw new AppError("repeatDays values must be integers between 0 (Sun) and 6 (Sat).", 422);
    }
  }
};

// ─── Reminders ────────────────────────────────────────────────────────────────

/**
 * GET /patient/reminders
 * List the authenticated patient's reminders.
 * Supports ?status=active|paused|completed query filter.
 */
exports.getReminders = catchAsync(async (req, res) => {
  const filter = { patientUserId: req.user._id };
  const since = req.query.since;

  if (req.query.status) {
    const status = String(req.query.status).toLowerCase();
    if (VALID_STATUSES.includes(status)) {
      filter.status = status;
    }
  }

  if (since) {
    filter.updatedAt = { $gt: new Date(since) };
  }

  const reminders = await MedicineReminder.find(filter)
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  res.status(200).json({ success: true, data: reminders });
});

/**
 * POST /patient/reminders
 * Create a patient_custom medicine reminder.
 *
 * Body fields:
 *   medicineName      string  required
 *   dosage            string  required
 *   frequency         string  optional
 *   startDate         date    required
 *   endDate           date    optional (defaults to 1 year from startDate)
 *   times             string[] required  HH:mm format
 *   repeatType        string  optional  daily|weekly|custom_days|every_x_hours (default: daily)
 *   repeatDays        number[] optional  [0-6] weekdays for weekly/custom_days
 *   repeatIntervalHours number optional  1-24 for every_x_hours
 *   notes             string  optional
 */
exports.createReminder = catchAsync(async (req, res) => {
  const {
    medicineName,
    dosage,
    frequency,
    startDate,
    endDate,
    times,
    repeatType = "daily",
    repeatDays = [],
    repeatIntervalHours,
    notes,
  } = req.body;

  // ── Validation ──────────────────────────────────────────────────────────────
  if (!medicineName || !String(medicineName).trim()) {
    throw new AppError("Medicine name is required.", 422);
  }

  if (!dosage || !String(dosage).trim()) {
    throw new AppError("Dosage is required.", 422);
  }

  if (!startDate) {
    throw new AppError("Start date is required.", 422);
  }

  const parsedStart = new Date(startDate);
  if (Number.isNaN(parsedStart.getTime())) {
    throw new AppError("Invalid start date.", 422);
  }

  // endDate is optional — default to 1 year from start
  let parsedEnd;
  if (endDate) {
    parsedEnd = new Date(endDate);
    if (Number.isNaN(parsedEnd.getTime())) {
      throw new AppError("Invalid end date.", 422);
    }
    if (parsedStart > parsedEnd) {
      throw new AppError("Start date must be on or before end date.", 422);
    }
  } else {
    parsedEnd = new Date(parsedStart);
    parsedEnd.setFullYear(parsedEnd.getFullYear() + 1);
  }

  validateTimes(times);

  if (!VALID_REPEAT_TYPES.includes(repeatType)) {
    throw new AppError(`repeatType must be one of: ${VALID_REPEAT_TYPES.join(", ")}.`, 422);
  }

  if (["weekly", "custom_days"].includes(repeatType)) {
    if (!repeatDays || repeatDays.length === 0) {
      throw new AppError("repeatDays is required when repeatType is weekly or custom_days.", 422);
    }
    validateRepeatDays(repeatDays);
  }

  if (repeatType === "every_x_hours") {
    if (!repeatIntervalHours || repeatIntervalHours < 1 || repeatIntervalHours > 24) {
      throw new AppError("repeatIntervalHours must be between 1 and 24 when using every_x_hours.", 422);
    }
  }

  const reminder = await MedicineReminder.create({
    patientUserId: req.user._id,
    type: "patient_custom",
    medicineName: String(medicineName).trim(),
    dosage: String(dosage).trim(),
    frequency: frequency ? String(frequency).trim() : "",
    startDate: parsedStart,
    endDate: parsedEnd,
    times,
    status: "active",
    repeatType,
    repeatDays: ["weekly", "custom_days"].includes(repeatType) ? repeatDays : [],
    repeatIntervalHours: repeatType === "every_x_hours" ? Number(repeatIntervalHours) : null,
    notes: notes ? String(notes).trim() : "",
  });

  res.status(201).json({ success: true, data: reminder });
});

/**
 * PUT /patient/reminders/:id
 * Update a patient_custom reminder. Doctor-prescribed reminders cannot be edited.
 */
exports.updateReminder = catchAsync(async (req, res) => {
  const reminder = await MedicineReminder.findById(req.params.id);

  if (!reminder) {
    throw new AppError("Reminder not found.", 404);
  }

  if (String(reminder.patientUserId) !== String(req.user._id)) {
    throw new AppError("You are not authorised to update this reminder.", 403);
  }

  if (reminder.type !== "patient_custom") {
    throw new AppError("Doctor-prescribed reminders cannot be edited.", 403);
  }

  const {
    medicineName,
    dosage,
    frequency,
    startDate,
    endDate,
    times,
    repeatType,
    repeatDays,
    repeatIntervalHours,
    notes,
  } = req.body;

  if (medicineName !== undefined) {
    if (!String(medicineName).trim()) {
      throw new AppError("Medicine name cannot be empty.", 422);
    }
    reminder.medicineName = String(medicineName).trim();
  }

  if (dosage !== undefined) {
    if (!String(dosage).trim()) {
      throw new AppError("Dosage cannot be empty.", 422);
    }
    reminder.dosage = String(dosage).trim();
  }

  if (frequency !== undefined) {
    reminder.frequency = String(frequency).trim();
  }

  if (notes !== undefined) {
    reminder.notes = String(notes).trim().slice(0, 500);
  }

  if (startDate !== undefined) {
    const parsedStart = new Date(startDate);
    if (Number.isNaN(parsedStart.getTime())) {
      throw new AppError("Invalid start date.", 422);
    }
    reminder.startDate = parsedStart;
  }

  if (endDate !== undefined) {
    if (endDate === null || endDate === "") {
      // Clear endDate → reset to 1 year from startDate
      const newEnd = new Date(reminder.startDate);
      newEnd.setFullYear(newEnd.getFullYear() + 1);
      reminder.endDate = newEnd;
    } else {
      const parsedEnd = new Date(endDate);
      if (Number.isNaN(parsedEnd.getTime())) {
        throw new AppError("Invalid end date.", 422);
      }
      reminder.endDate = parsedEnd;
    }
  }

  if (reminder.startDate > reminder.endDate) {
    throw new AppError("Start date must be on or before end date.", 422);
  }

  if (times !== undefined) {
    validateTimes(times);
    reminder.times = times;
  }

  if (repeatType !== undefined) {
    if (!VALID_REPEAT_TYPES.includes(repeatType)) {
      throw new AppError(`repeatType must be one of: ${VALID_REPEAT_TYPES.join(", ")}.`, 422);
    }
    reminder.repeatType = repeatType;
  }

  if (repeatDays !== undefined) {
    validateRepeatDays(repeatDays);
    reminder.repeatDays = repeatDays;
  }

  if (repeatIntervalHours !== undefined) {
    if (repeatIntervalHours !== null && (repeatIntervalHours < 1 || repeatIntervalHours > 24)) {
      throw new AppError("repeatIntervalHours must be between 1 and 24.", 422);
    }
    reminder.repeatIntervalHours = repeatIntervalHours;
  }

  await reminder.save();

  res.status(200).json({ success: true, data: reminder });
});

/**
 * PATCH /patient/reminders/:id/pause
 * Pause an active reminder (works for both types).
 */
exports.pauseReminder = catchAsync(async (req, res) => {
  const reminder = await MedicineReminder.findById(req.params.id);

  if (!reminder) {
    throw new AppError("Reminder not found.", 404);
  }

  if (String(reminder.patientUserId) !== String(req.user._id)) {
    throw new AppError("You are not authorised to pause this reminder.", 403);
  }

  if (reminder.status !== "active") {
    throw new AppError("Only active reminders can be paused.", 400);
  }

  reminder.status = "paused";
  await reminder.save();

  res.status(200).json({ success: true, data: reminder });
});

/**
 * PATCH /patient/reminders/:id/resume
 * Resume a paused reminder.
 */
exports.resumeReminder = catchAsync(async (req, res) => {
  const reminder = await MedicineReminder.findById(req.params.id);

  if (!reminder) {
    throw new AppError("Reminder not found.", 404);
  }

  if (String(reminder.patientUserId) !== String(req.user._id)) {
    throw new AppError("You are not authorised to resume this reminder.", 403);
  }

  if (reminder.status !== "paused") {
    throw new AppError("Only paused reminders can be resumed.", 400);
  }

  reminder.status = "active";
  await reminder.save();

  res.status(200).json({ success: true, data: reminder });
});

/**
 * DELETE /patient/reminders/:id
 * Delete a patient_custom reminder. Doctor-prescribed reminders can only be paused/cancelled.
 */
exports.deleteReminder = catchAsync(async (req, res) => {
  const reminder = await MedicineReminder.findById(req.params.id);

  if (!reminder) {
    throw new AppError("Reminder not found.", 404);
  }

  if (String(reminder.patientUserId) !== String(req.user._id)) {
    throw new AppError("You are not authorised to delete this reminder.", 403);
  }

  if (reminder.type !== "patient_custom") {
    throw new AppError(
      "Doctor-prescribed reminders cannot be deleted. You can pause or cancel them instead.",
      403
    );
  }

  await MedicineReminder.findByIdAndDelete(reminder._id);

  res.status(200).json({ success: true, message: "Reminder deleted." });
});

/**
 * GET /patient/reminders/history
 * Retrieve sent medicine reminder notifications for the authenticated patient.
 */
exports.getReminderHistory = catchAsync(async (req, res) => {
  const logs = await NotificationLog.find({
    patientUserId: req.user._id,
    category: "medicine_reminder",
  })
    .sort({ sentAt: -1 })
    .limit(50)
    .lean();

  res.status(200).json({ success: true, data: logs });
});

// ─── Notifications (Inbox) ───────────────────────────────────────────────────

/**
 * GET /patient/notifications
 * Return all notification categories from the last 7 days.
 */
exports.getNotifications = catchAsync(async (req, res) => {
  const sevenDaysAgo = daysAgo(7);
  const since = req.query.since;

  const filter = {
    patientUserId: req.user._id,
    createdAt: { $gte: sevenDaysAgo },
  };

  if (since) {
    filter.updatedAt = { $gt: new Date(since) };
  }

  const notifications = await NotificationLog.find(filter)
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  res.status(200).json({ success: true, data: notifications });
});

/**
 * GET /patient/notifications/unread-count
 * Count unread notifications from the last 7 days.
 */
exports.getUnreadCount = catchAsync(async (req, res) => {
  const sevenDaysAgo = daysAgo(7);

  const count = await NotificationLog.countDocuments({
    patientUserId: req.user._id,
    isRead: false,
    createdAt: { $gte: sevenDaysAgo },
  });

  res.status(200).json({ success: true, data: { count } });
});

/**
 * PATCH /patient/notifications/:id/read
 * Mark a single notification as read.
 */
exports.markAsRead = catchAsync(async (req, res) => {
  const notification = await NotificationLog.findById(req.params.id);

  if (!notification) {
    throw new AppError("Notification not found.", 404);
  }

  if (String(notification.patientUserId) !== String(req.user._id)) {
    throw new AppError("You are not authorised to update this notification.", 403);
  }

  notification.isRead = true;
  notification.readAt = new Date();
  await notification.save();

  res.status(200).json({ success: true, data: notification });
});

/**
 * PATCH /patient/notifications/read-all
 * Mark all unread notifications as read for the authenticated patient.
 */
exports.markAllAsRead = catchAsync(async (req, res) => {
  await NotificationLog.deleteMany({ patientUserId: req.user._id });

  res.status(200).json({ success: true, message: "All notifications deleted." });
});
