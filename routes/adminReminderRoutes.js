const express = require("express");
const { param, query } = require("express-validator");

const controller = require("../controllers/adminReminderController");
const { protect, restrictTo } = require("../middleware/auth");
const validate = require("../middleware/validate");

const router = express.Router();

router.use(protect);
router.use(restrictTo("Super Admin"));

// GET /admin/reminders/stats
router.get("/stats", controller.getReminderStats);

// GET /admin/reminders/logs?page=1&limit=20
router.get(
  "/logs",
  [
    query("page")
      .optional({ values: "falsy" })
      .isInt({ min: 1 })
      .withMessage("Page must be a positive integer."),
    query("limit")
      .optional({ values: "falsy" })
      .isInt({ min: 1, max: 100 })
      .withMessage("Limit must be between 1 and 100."),
  ],
  validate,
  controller.getNotificationLogs
);

// POST /admin/reminders/resend/:logId
router.post(
  "/resend/:logId",
  [param("logId").isMongoId().withMessage("Invalid log id.")],
  validate,
  controller.resendNotification
);

module.exports = router;
