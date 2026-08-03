const express = require("express");
const router = express.Router();

const reportController = require("../controllers/reportController");
const { protect, restrictTo } = require("../middleware/auth");

router.use(protect);

// GET /api/v1/reports?type=users|hospitals|activity&format=json|csv
router.get("/", reportController.getReport);

// GET /api/v1/reports/overview — dashboard summary card data
router.get("/overview", reportController.getDashboardOverview);

module.exports = router;
