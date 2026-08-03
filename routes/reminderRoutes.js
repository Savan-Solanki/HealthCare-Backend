const express = require("express");
const { body, param, query } = require("express-validator");

const reminderController = require("../controllers/reminderController");
const { protectPatient } = require("../middleware/auth");
const validate = require("../middleware/validate");

const router = express.Router();

// All routes require an authenticated patient
router.use(protectPatient);

// ─── Reminder CRUD ────────────────────────────────────────────────────────────

router.get(
  "/reminders/history",
  reminderController.getReminderHistory
);

router.get(
  "/reminders",
  [
    query("status")
      .optional({ values: "falsy" })
      .isIn(["active", "paused", "completed"])
      .withMessage("Status must be active, paused, or completed."),
  ],
  validate,
  reminderController.getReminders
);

router.post(
  "/reminders",
  [
    body("medicineName")
      .trim()
      .notEmpty()
      .withMessage("Medicine name is required.")
      .isLength({ max: 200 })
      .withMessage("Medicine name cannot exceed 200 characters."),
    body("dosage")
      .trim()
      .notEmpty()
      .withMessage("Dosage is required.")
      .isLength({ max: 100 })
      .withMessage("Dosage cannot exceed 100 characters."),
    body("frequency")
      .optional({ values: "falsy" })
      .trim()
      .isLength({ max: 100 })
      .withMessage("Frequency cannot exceed 100 characters."),
    body("startDate")
      .notEmpty()
      .withMessage("Start date is required.")
      .isISO8601()
      .withMessage("Start date must be a valid date."),
    body("endDate")
      .notEmpty()
      .withMessage("End date is required.")
      .isISO8601()
      .withMessage("End date must be a valid date."),
    body("times")
      .isArray({ min: 1, max: 6 })
      .withMessage("Provide between 1 and 6 reminder times."),
    body("times.*")
      .matches(/^([01]\d|2[0-3]):[0-5]\d$/)
      .withMessage("Each time must be in HH:mm format (00:00–23:59)."),
  ],
  validate,
  reminderController.createReminder
);

router.put(
  "/reminders/:id",
  [
    param("id").isMongoId().withMessage("Invalid reminder id."),
    body("medicineName")
      .optional({ values: "falsy" })
      .trim()
      .isLength({ max: 200 })
      .withMessage("Medicine name cannot exceed 200 characters."),
    body("dosage")
      .optional({ values: "falsy" })
      .trim()
      .isLength({ max: 100 })
      .withMessage("Dosage cannot exceed 100 characters."),
    body("frequency")
      .optional({ values: "falsy" })
      .trim()
      .isLength({ max: 100 })
      .withMessage("Frequency cannot exceed 100 characters."),
    body("startDate")
      .optional({ values: "falsy" })
      .isISO8601()
      .withMessage("Start date must be a valid date."),
    body("endDate")
      .optional({ values: "falsy" })
      .isISO8601()
      .withMessage("End date must be a valid date."),
    body("times")
      .optional()
      .isArray({ min: 1, max: 6 })
      .withMessage("Provide between 1 and 6 reminder times."),
    body("times.*")
      .optional()
      .matches(/^([01]\d|2[0-3]):[0-5]\d$/)
      .withMessage("Each time must be in HH:mm format (00:00–23:59)."),
  ],
  validate,
  reminderController.updateReminder
);

router.patch(
  "/reminders/:id/pause",
  [param("id").isMongoId().withMessage("Invalid reminder id.")],
  validate,
  reminderController.pauseReminder
);

router.patch(
  "/reminders/:id/resume",
  [param("id").isMongoId().withMessage("Invalid reminder id.")],
  validate,
  reminderController.resumeReminder
);

router.delete(
  "/reminders/:id",
  [param("id").isMongoId().withMessage("Invalid reminder id.")],
  validate,
  reminderController.deleteReminder
);

// ─── Notification Inbox ───────────────────────────────────────────────────────

router.get("/notifications", reminderController.getNotifications);

router.get("/notifications/unread-count", reminderController.getUnreadCount);

router.patch(
  "/notifications/read-all",
  reminderController.markAllAsRead
);

router.patch(
  "/notifications/:id/read",
  [param("id").isMongoId().withMessage("Invalid notification id.")],
  validate,
  reminderController.markAsRead
);

module.exports = router;
