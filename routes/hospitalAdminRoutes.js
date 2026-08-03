const express = require("express");
const { body, param } = require("express-validator");
const controller = require("../controllers/hospitalAdminController");
const admissionController = require("../controllers/admissionController");
const dischargeController = require("../controllers/dischargeSummaryController");
const admissionTreatmentController = require("../controllers/admissionTreatmentController");
const doctorSlotController = require("../controllers/doctorSlotController");
const { protect, restrictTo } = require("../middleware/auth");
const validate = require("../middleware/validate");

const router = express.Router();

router.use(protect);

const idParamRule = [param("id").isMongoId().withMessage("Invalid id")];
const hospitalAdminOnly = restrictTo("Hospital Admin", "Super Admin");
const hospitalOperations = restrictTo("Hospital Admin", "Receptionist", "Doctor", "Super Admin");

router.get("/dashboard", hospitalAdminOnly, controller.getDashboard);

router
  .route("/patients")
  .get(hospitalOperations, controller.getPatients)
  .post(
    hospitalOperations,
    [
      body("firstName").trim().notEmpty().withMessage("First name is required"),
      body("lastName").trim().notEmpty().withMessage("Last name is required"),
      body("status").optional().isIn(["Active", "Inactive"]),
      body("gender").optional({ values: "falsy" }).isIn(["Male", "Female", "Other"]),
      body("age").optional({ values: "falsy" }).isInt({ min: 0 }),
    ],
    validate,
    controller.createPatient
  );

router
  .route("/patients/:id")
  .put(hospitalOperations, idParamRule, validate, controller.updatePatient)
  .delete(hospitalOperations, idParamRule, validate, controller.deletePatient);

router.get("/doctors", hospitalOperations, controller.getDoctors);

router
  .route("/doctors")
  .post(
    hospitalAdminOnly,
    [
      body("firstName").trim().notEmpty().withMessage("First name is required"),
      body("lastName").trim().notEmpty().withMessage("Last name is required"),
      body("email").isEmail().withMessage("Valid doctor email is required").normalizeEmail(),
      body("password")
        .isLength({ min: 8 })
        .withMessage("Doctor password must be at least 8 characters")
        .matches(/\d/)
        .withMessage("Doctor password must contain a number"),
      body("gender").optional({ values: "falsy" }).isIn(["Male", "Female"]),
      body("consultationFee").optional({ values: "falsy" }).isFloat({ min: 0 }),
    ],
    validate,
    controller.createDoctor
  );

router
  .route("/doctors/:id")
  .put(
    hospitalAdminOnly,
    [
      ...idParamRule,
      body("email").optional({ values: "falsy" }).isEmail().withMessage("Valid doctor email is required").normalizeEmail(),
      body("password")
        .optional({ values: "falsy" })
        .isLength({ min: 8 })
        .withMessage("Doctor password must be at least 8 characters")
        .matches(/\d/)
        .withMessage("Doctor password must contain a number"),
    ],
    validate,
    controller.updateDoctor
  )
  .delete(hospitalAdminOnly, idParamRule, validate, controller.deleteDoctor);

router
  .route("/departments")
  .get(hospitalAdminOnly, controller.getDepartments)
  .post(
    hospitalAdminOnly,
    [
      body("departmentName").trim().notEmpty().withMessage("Department name is required"),
      body("departmentHead").trim().notEmpty().withMessage("Department head is required"),
      body("totalStaff").isInt({ min: 0 }).withMessage("Total staff must be zero or more"),
    ],
    validate,
    controller.createDepartment
  );

router
  .route("/departments/:id")
  .put(hospitalAdminOnly, idParamRule, validate, controller.updateDepartment)
  .delete(hospitalAdminOnly, idParamRule, validate, controller.deleteDepartment);

router
  .route("/staff")
  .get(hospitalAdminOnly, controller.getStaff)
  .post(
    hospitalAdminOnly,
    [
      body("firstName").trim().notEmpty().withMessage("First name is required"),
      body("lastName").trim().notEmpty().withMessage("Last name is required"),
      body("department").isIn(["Administration", "Nursing", "Support"]),
      body("shift").isIn(["Day", "Night", "Rotating"]),
      body("role").trim().notEmpty().withMessage("Role is required"),
      body("salary").optional({ values: "falsy" }).isFloat({ min: 0 }),
    ],
    validate,
    controller.createStaff
  );

router
  .route("/staff/:id")
  .put(hospitalAdminOnly, idParamRule, validate, controller.updateStaff)
  .delete(hospitalAdminOnly, idParamRule, validate, controller.deleteStaff);

router
  .route("/appointments")
  .get(hospitalOperations, controller.getAppointments)
  .post(
    hospitalOperations,
    [
      body("patientName").trim().notEmpty().withMessage("Patient name is required"),
      body("doctorName").trim().notEmpty().withMessage("Doctor name is required"),
      body("appointmentDate").notEmpty().withMessage("Appointment date is required"),
      body("status").optional().isIn(["Scheduled", "Confirmed", "Completed", "Cancelled"]),
      body("consultationFee").optional({ values: "falsy" }).isFloat({ min: 0 }),
    ],
    validate,
    controller.createAppointment
  );

router
  .route("/appointments/:id")
  .put(hospitalOperations, idParamRule, validate, controller.updateAppointment)
  .delete(hospitalOperations, idParamRule, validate, controller.deleteAppointment);

router.patch(
  "/appointments/:id/payment",
  hospitalOperations,
  [
    ...idParamRule,
    body("amount").isFloat({ min: 0 }).withMessage("Amount must be zero or more"),
    body("method").isIn(["Cash", "Card", "UPI", "Insurance"]),
    body("paymentStatus").isIn(["Pending", "Paid"]),
  ],
  validate,
  controller.updateAppointmentPayment
);

// ─── Admissions Routes ────────────────────────────────────────────────────────
router.get("/admissions/stats", hospitalOperations, admissionController.getStats);
router.get("/admissions/reports", hospitalOperations, admissionController.exportReports);

router
  .route("/admissions")
  .get(hospitalOperations, admissionController.getAdmissions)
  .post(
    hospitalOperations,
    [
      body("appointmentId").isMongoId().withMessage("Valid Appointment ID is required"),
      body("admissionReason").trim().notEmpty().withMessage("Admission reason is required"),
    ],
    validate,
    admissionController.admitPatient
  );

router
  .route("/admissions/:id")
  .get(hospitalOperations, idParamRule, validate, admissionController.getAdmissionDetails);

router.patch(
  "/admissions/:id/room",
  restrictTo("Hospital Admin", "Receptionist", "Super Admin"),
  [
    ...idParamRule,
    body("roomNumber").optional({ values: "falsy" }).trim(),
    body("bedNumber").optional({ values: "falsy" }).trim(),
  ],
  validate,
  admissionController.updateRoom
);

router.get("/admissions/:id/slip", hospitalOperations, idParamRule, validate, admissionController.getSlip);

// ─── Discharges Summary Routes ────────────────────────────────────────────────
router.get("/discharges", hospitalOperations, dischargeController.getDischarges);
router.get("/discharges/:id", hospitalOperations, idParamRule, validate, dischargeController.getDischargeDetails);
router.get("/discharges/:id/pdf", hospitalOperations, idParamRule, validate, dischargeController.downloadSummaryPdf);
router.post(
  "/admissions/:admissionId/discharge",
  hospitalOperations,
  [
    param("admissionId").isMongoId().withMessage("Invalid admission ID"),
    body("diagnosis").trim().notEmpty().withMessage("Diagnosis is required"),
  ],
  validate,
  dischargeController.dischargePatient
);

// ─── IPD Admission Treatment Routes ───────────────────────────────────────────
router.post(
  "/admissions/:admissionId/treatments",
  hospitalOperations,
  [param("admissionId").isMongoId().withMessage("Invalid admission ID")],
  validate,
  admissionTreatmentController.createTreatment
);

router.get(
  "/admissions/:admissionId/treatments",
  hospitalOperations,
  [param("admissionId").isMongoId().withMessage("Invalid admission ID")],
  validate,
  admissionTreatmentController.getTreatments
);

router.put(
  "/admissions/:admissionId/treatments/:treatmentId",
  hospitalOperations,
  [
    param("admissionId").isMongoId().withMessage("Invalid admission ID"),
    param("treatmentId").isMongoId().withMessage("Invalid treatment ID")
  ],
  validate,
  admissionTreatmentController.updateTreatment
);

router.delete(
  "/admissions/:admissionId/treatments/:treatmentId",
  hospitalOperations,
  [
    param("admissionId").isMongoId().withMessage("Invalid admission ID"),
    param("treatmentId").isMongoId().withMessage("Invalid treatment ID")
  ],
  validate,
  admissionTreatmentController.deleteTreatment
);

router.get(
  "/admissions/:admissionId/billing-summary",
  hospitalOperations,
  [param("admissionId").isMongoId().withMessage("Invalid admission ID")],
  validate,
  admissionTreatmentController.getBillingSummary
);

// ─── Slot & Leave Management ──────────────────────────────────────────────────
// NOTE: /slots/generate-from-availability MUST be before /slots/:id
router.post("/slots/generate-from-availability", hospitalOperations, doctorSlotController.generateSlotsFromAvailability);

router.route("/slots")
  .get(hospitalOperations, doctorSlotController.getSlots)
  .post(hospitalOperations, doctorSlotController.createSlots);

router.route("/slots/:id")
  .put(hospitalOperations, doctorSlotController.updateSlotStatus)
  .delete(hospitalOperations, doctorSlotController.deleteSlot);

router.route("/leaves")
  .get(hospitalOperations, doctorSlotController.getLeaves)
  .post(hospitalOperations, doctorSlotController.markLeave);

router.route("/leaves/:id")
  .delete(hospitalOperations, doctorSlotController.cancelLeave);

router.route("/doctors/:doctorId/availabilities")
  .get(hospitalOperations, doctorSlotController.getWeeklyAvailability)
  .post(hospitalOperations, doctorSlotController.updateWeeklyAvailability);

module.exports = router;
