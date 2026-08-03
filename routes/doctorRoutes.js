const express = require("express");
const { body, param, query } = require("express-validator");
const controller = require("../controllers/doctorController");
const admissionController = require("../controllers/admissionController");
const dischargeController = require("../controllers/dischargeSummaryController");
const doctorSlotController = require("../controllers/doctorSlotController");
const { protect, restrictTo } = require("../middleware/auth");
const validate = require("../middleware/validate");

const router = express.Router();

router.use(protect);
router.use(restrictTo("Doctor"));

// ─── Dashboard & Profile ──────────────────────────────────────────────────────
router.get("/dashboard", controller.getDashboard);
router.get("/hospital-profile", controller.getHospitalProfile);

// ─── Patients ─────────────────────────────────────────────────────────────────
router.get(
  "/patients",
  [
    query("search").optional({ values: "falsy" }).trim().isLength({ max: 120 }).withMessage("Search is too long"),
    query("limit").optional({ values: "falsy" }).isInt({ min: 1, max: 50 }).withMessage("Limit must be between 1 and 50"),
  ],
  validate,
  controller.getPatients
);
router.get("/patients/:id", controller.getPatientDetails);

// ─── Appointments ─────────────────────────────────────────────────────────────
router.get("/appointments", controller.getAppointments);
router.patch(
  "/appointments/:id/status",
  [
    param("id").isMongoId().withMessage("Invalid appointment id"),
    body("status")
      .isIn(["Scheduled", "Confirmed", "Completed", "Cancelled"])
      .withMessage("Invalid appointment status"),
  ],
  validate,
  controller.updateAppointmentStatus
);

// ─── Prescriptions ────────────────────────────────────────────────────────────
router.get("/prescriptions", controller.getPrescriptions);
router.get(
  "/prescriptions/:id/download",
  [param("id").isMongoId().withMessage("Invalid prescription id")],
  validate,
  controller.getPrescriptionDownload
);
router.post(
  "/prescriptions",
  [
    body("patientName").trim().notEmpty().withMessage("Patient name is required"),
    body("patientId").optional({ values: "falsy" }).isMongoId().withMessage("Invalid patient id"),
    body("diagnosis").trim().notEmpty().withMessage("Diagnosis is required"),
    body("prescriptionDate").notEmpty().withMessage("Prescription date is required"),
    body("medicines").isArray({ min: 1 }).withMessage("At least one medicine is required"),
    body("medicines.*.medicineName").trim().notEmpty().withMessage("Medicine name is required"),
    body("medicines.*.dosage").trim().notEmpty().withMessage("Dosage is required"),
    body("medicines.*.frequency").trim().notEmpty().withMessage("Frequency is required"),
    body("medicines.*.duration").trim().notEmpty().withMessage("Duration is required"),
    body("medicines.*.schedule.morning").optional().isBoolean().toBoolean(),
    body("medicines.*.schedule.afternoon").optional().isBoolean().toBoolean(),
    body("medicines.*.schedule.night").optional().isBoolean().toBoolean(),
    body("medicines.*.schedule.morningTime")
      .optional({ values: "falsy" })
      .matches(/^([01]\d|2[0-3]):[0-5]\d$/)
      .withMessage("Morning time must use HH:mm format"),
    body("medicines.*.schedule.afternoonTime")
      .optional({ values: "falsy" })
      .matches(/^([01]\d|2[0-3]):[0-5]\d$/)
      .withMessage("Afternoon time must use HH:mm format"),
    body("medicines.*.schedule.nightTime")
      .optional({ values: "falsy" })
      .matches(/^([01]\d|2[0-3]):[0-5]\d$/)
      .withMessage("Night time must use HH:mm format"),
    body("includemedikwikLogo").optional().isBoolean().toBoolean(),
    body("followUpDate").optional({ values: "falsy" }).isISO8601().withMessage("Invalid follow-up date"),
    body("instruction").optional({ values: "falsy" }).trim().isLength({ max: 1000 }),
    body("doctorNotes").optional({ values: "falsy" }).trim().isLength({ max: 1000 }),
  ],
  validate,
  controller.createPrescription
);

// ─── Prescription Templates ───────────────────────────────────────────────────
router.get(
  "/prescription-templates",
  [
    query("search").optional({ values: "falsy" }).trim().isLength({ max: 120 }),
    query("sort").optional().isIn(["recent", "mostUsed", "favorites", "name"]),
    query("limit").optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  controller.getPrescriptionTemplates
);

router.post(
  "/prescription-templates",
  [
    body("templateName").trim().notEmpty().withMessage("Template name is required"),
    body("diagnosis").optional({ values: "falsy" }).trim(),
    body("medicines").optional().isArray(),
    body("medicines.*.medicineName").optional().trim().notEmpty(),
    body("medicines.*.dosage").optional().trim().notEmpty(),
    body("medicines.*.frequency").optional().trim().notEmpty(),
    body("medicines.*.duration").optional().trim().notEmpty(),
    body("instruction").optional({ values: "falsy" }).trim(),
  ],
  validate,
  controller.createPrescriptionTemplate
);

router.put(
  "/prescription-templates/:id",
  [
    param("id").isMongoId().withMessage("Invalid template id"),
    body("templateName").optional().trim().notEmpty().withMessage("Template name cannot be empty"),
    body("medicines").optional().isArray(),
  ],
  validate,
  controller.updatePrescriptionTemplate
);

router.delete(
  "/prescription-templates/:id",
  [param("id").isMongoId().withMessage("Invalid template id")],
  validate,
  controller.deletePrescriptionTemplate
);

router.post(
  "/prescription-templates/:id/duplicate",
  [param("id").isMongoId().withMessage("Invalid template id")],
  validate,
  controller.duplicatePrescriptionTemplate
);

router.patch(
  "/prescription-templates/:id/favorite",
  [param("id").isMongoId().withMessage("Invalid template id")],
  validate,
  controller.togglePrescriptionTemplateFavorite
);

router.patch(
  "/prescription-templates/:id/use",
  [param("id").isMongoId().withMessage("Invalid template id")],
  validate,
  controller.recordPrescriptionTemplateUse
);

// ─── Doctor Medicines (Personal Library) ──────────────────────────────────────
router.get(
  "/medicines",
  [query("search").optional({ values: "falsy" }).trim().isLength({ max: 120 })],
  validate,
  controller.getDoctorMedicines
);

router.post(
  "/medicines",
  [
    body("medicineName").trim().notEmpty().withMessage("Medicine name is required"),
    body("dosage").trim().notEmpty().withMessage("Dosage is required"),
    body("frequency").trim().notEmpty().withMessage("Frequency is required"),
    body("duration").trim().notEmpty().withMessage("Duration is required"),
  ],
  validate,
  controller.createDoctorMedicine
);

router.delete(
  "/medicines/:id",
  [param("id").isMongoId().withMessage("Invalid medicine id")],
  validate,
  controller.deleteDoctorMedicine
);

// ─── Doctor Admissions Endpoints ─────────────────────────────────────────────
router.get("/admissions", admissionController.getAdmissions);
router.get("/admissions/:id", admissionController.getAdmissionDetails);
router.patch(
  "/admissions/:id/status",
  [
    param("id").isMongoId().withMessage("Invalid admission id"),
    body("status")
      .isIn(["Admitted", "Under Treatment", "Critical", "Stable"])
      .withMessage("Invalid status option"),
  ],
  validate,
  admissionController.updateAdmissionStatus
);
router.post(
  "/admissions/:admissionId/discharge",
  [
    param("admissionId").isMongoId().withMessage("Invalid admission ID"),
    body("diagnosis").trim().notEmpty().withMessage("Diagnosis is required"),
  ],
  validate,
  dischargeController.dischargePatient
);

// ─── Slot & Leave Management ──────────────────────────────────────────────────
// NOTE: /slots/generate-from-availability MUST be before /slots/:id
router.post("/slots/generate-from-availability", doctorSlotController.generateSlotsFromAvailability);

router.route("/slots")
  .get(doctorSlotController.getSlots)
  .post(doctorSlotController.createSlots);

router.route("/slots/:id")
  .put(doctorSlotController.updateSlotStatus)
  .delete(doctorSlotController.deleteSlot);

router.route("/leaves")
  .get(doctorSlotController.getLeaves)
  .post(doctorSlotController.markLeave);

router.route("/leaves/:id")
  .delete(doctorSlotController.cancelLeave);

router.route("/availabilities")
  .get(doctorSlotController.getWeeklyAvailability)
  .post(doctorSlotController.updateWeeklyAvailability);

module.exports = router;
