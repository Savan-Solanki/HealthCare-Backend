const express = require("express");
const controller = require("../controllers/rateLimitController");
const { protect, restrictTo } = require("../middleware/auth");

const router = express.Router();

// Only Super Admins can access and manage rate limit rules/blocks
router.use(protect);
router.use(restrictTo("Super Admin"));

router.get("/violations", controller.getViolations);
router.get("/blocked", controller.getBlockedKeys);
router.post("/unblock", controller.manualUnblock);

module.exports = router;
