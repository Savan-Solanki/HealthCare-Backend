"use strict";
const express = require("express");
const router = express.Router();

const { protect, restrictTo } = require("../middleware/auth");
const storageController = require("../controllers/storageController");

// All storage routes are Super Admin only
router.use(protect);
router.use(restrictTo("Super Admin"));

// ─── Dashboard ────────────────────────────────────────────────────────────────
router.get("/dashboard", storageController.getDashboard);

// ─── Global Trend ─────────────────────────────────────────────────────────────
router.get("/trend", storageController.getGlobalTrend);

// ─── Export ───────────────────────────────────────────────────────────────────
router.get("/export", storageController.exportStorage);

// ─── Hospital List ────────────────────────────────────────────────────────────
router.get("/hospitals", storageController.getHospitalStorage);

// ─── Hospital Detail ──────────────────────────────────────────────────────────
router.get("/hospitals/:id", storageController.getHospitalDetail);

// ─── Prescriptions by Hospital ────────────────────────────────────────────────
router.get("/prescriptions", storageController.getPrescriptionsByHospital);

module.exports = router;
