const express = require("express");
const { body } = require("express-validator");
const router = express.Router();

const systemController = require("../controllers/systemController");
const { protect, restrictTo } = require("../middleware/auth");
const validate = require("../middleware/validate");

router.use(protect);

// ─── Routes ────────────────────────────────────────────────────────────────────

// GET /api/v1/system/status — all authenticated users can view system health
router.get("/status", systemController.getSystemStatus);

// GET /api/v1/system/logs — Super Admin only
router.get(
  "/logs",
  restrictTo("Super Admin"),
  systemController.getSystemLogs
);

// GET /api/v1/system/activity — Super Admin only
router.get(
  "/activity",
  restrictTo("Super Admin"),
  systemController.getSystemActivity
);

// POST /api/v1/system/action — Super Admin only
router.post(
  "/action",
  restrictTo("Super Admin"),
  [body("action").trim().notEmpty().withMessage("Action is required")],
  validate,
  systemController.triggerSystemAction
);

module.exports = router;
