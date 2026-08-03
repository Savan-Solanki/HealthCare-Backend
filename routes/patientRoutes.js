const express = require("express");
const { body, param, query } = require("express-validator");

const patientController = require("../controllers/patientController");
const adController = require("../controllers/adController");
const admissionController = require("../controllers/admissionController");
const dischargeController = require("../controllers/dischargeSummaryController");
const { protectPatient } = require("../middleware/auth");
const {
  ALLOWED_PRESCRIPTION_MIME_TYPES,
  MAX_PRESCRIPTION_UPLOAD_BYTES,
  prescriptionUpload,
} = require("../middleware/prescriptionUpload");
const { handleSingleUpload } = require("../middleware/handleUpload");
const validate = require("../middleware/validate");

const paymentController = require("../controllers/paymentController");

const router = express.Router();

// Public webhook route (called by Razorpay asynchronously, bypassed JWT auth)
router.post("/payments/webhook", paymentController.handleWebhook);

router.use(protectPatient);

router.get("/ads/active", (req, res, next) => {
  req.query.audience = "patient";
  return adController.getActiveAds(req, res, next);
});
router.get("/dashboard", patientController.getDashboard);
router.get("/credits/history", patientController.getCreditHistory);
router.get(
  "/prescriptions",
  [
    query("source")
      .optional({ values: "falsy" })
      .isIn(["doctor_generated", "patient_uploaded"])
      .withMessage("Invalid prescription source filter."),
  ],
  validate,
  patientController.getPrescriptions
);
router.get(
  "/prescriptions/:id/download",
  [param("id").isMongoId().withMessage("Invalid prescription id")],
  validate,
  patientController.getPrescriptionDownload
);
router.delete(
  "/prescriptions/:id",
  [param("id").isMongoId().withMessage("Invalid prescription id")],
  validate,
  patientController.deletePrescription
);
const prescriptionUploadMetadataValidators = [
    body("diagnosis")
      .optional({ values: "falsy" })
      .trim()
      .isLength({ max: 160 })
      .withMessage("Diagnosis cannot exceed 160 characters."),
    body("doctorName")
      .optional({ values: "falsy" })
      .trim()
      .isLength({ max: 120 })
      .withMessage("Doctor name cannot exceed 120 characters."),
    body("hospitalName")
      .optional({ values: "falsy" })
      .trim()
      .isLength({ max: 200 })
      .withMessage("Hospital name cannot exceed 200 characters."),
    body("hospitalAddress")
      .optional({ values: "falsy" })
      .trim()
      .isLength({ max: 500 })
      .withMessage("Hospital address cannot exceed 500 characters."),
    body("instruction")
      .optional({ values: "falsy" })
      .trim()
      .isLength({ max: 1200 })
      .withMessage("Instruction cannot exceed 1200 characters."),
    body("prescriptionDate")
      .optional({ values: "falsy" })
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage("Select a valid prescription date."),
];

router.post(
  "/prescriptions/upload-session",
  [
    body("contentType")
      .trim()
      .isIn(ALLOWED_PRESCRIPTION_MIME_TYPES)
      .withMessage("Upload a JPG, PNG, WEBP, HEIC, or PDF prescription file."),
    body("fileSize")
      .isInt({ min: 1, max: MAX_PRESCRIPTION_UPLOAD_BYTES })
      .withMessage("Prescription photo exceeds the upload size limit."),
    body("fileName")
      .optional({ values: "falsy" })
      .trim()
      .isLength({ max: 255 })
      .withMessage("File name is too long."),
    ...prescriptionUploadMetadataValidators,
  ],
  validate,
  patientController.createPrescriptionUploadSession
);
router.post(
  "/prescriptions/upload-complete",
  [
    body("uploadToken")
      .trim()
      .notEmpty()
      .withMessage("Upload session expired. Please try again."),
  ],
  validate,
  patientController.completePrescriptionUpload
);
router.post(
  "/prescriptions/upload",
  handleSingleUpload(prescriptionUpload.single("prescription")),
  prescriptionUploadMetadataValidators,
  validate,
  patientController.uploadPrescription
);
router.get("/booking/options", patientController.getBookingOptions);
router.get(
  "/booking/hospitals/:hospitalId/doctors",
  [param("hospitalId").isMongoId().withMessage("Invalid hospital id")],
  validate,
  patientController.getBookingDoctors
);
router.get(
  "/booking/availability",
  [
    query("doctorId").isMongoId().withMessage("Invalid doctor id"),
    query("date")
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage("Select a valid appointment date."),
    query("excludeAppointmentId")
      .optional({ values: "falsy" })
      .isMongoId()
      .withMessage("Invalid appointment id"),
  ],
  validate,
  patientController.getBookingAvailability
);

const appointmentPatientDetailValidators = [
  body("appointmentDate")
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage("Select a valid appointment date."),
  body("appointmentTime")
    .matches(/^([01]\d|2[0-3]):[0-5]\d$/)
    .withMessage("Select a valid appointment time."),
  body("patientFirstName")
    .trim()
    .isLength({ min: 1, max: 80 })
    .withMessage("First name is required."),
  body("patientLastName")
    .trim()
    .isLength({ min: 1, max: 80 })
    .withMessage("Last name is required."),
  body("patientEmail")
    .isEmail()
    .withMessage("Valid email address is required.")
    .normalizeEmail(),
  body("purpose")
    .trim()
    .isLength({ min: 2, max: 160 })
    .withMessage("Purpose of appointment is required."),
  body("description")
    .optional({ values: "falsy" })
    .trim()
    .isLength({ max: 1200 })
    .withMessage("Description cannot exceed 1200 characters."),
];

router.post(
  "/appointments",
  [
    body("hospitalId").isMongoId().withMessage("Invalid hospital id"),
    body("doctorId").isMongoId().withMessage("Invalid doctor id"),
    ...appointmentPatientDetailValidators,
  ],
  validate,
  patientController.createAppointment
);
router.put(
  "/appointments/:id",
  [
    param("id").isMongoId().withMessage("Invalid appointment id"),
    ...appointmentPatientDetailValidators,
  ],
  validate,
  patientController.updateAppointment
);
router.delete(
  "/appointments/:id",
  [param("id").isMongoId().withMessage("Invalid appointment id")],
  validate,
  patientController.cancelAppointment
);

router.post(
  "/avatar/upload-session",
  [
    body("contentType")
      .trim()
      .isIn(["image/jpeg", "image/png", "image/webp"])
      .withMessage("Upload a JPG, PNG, or WEBP profile photo."),
    body("fileSize")
      .isInt({ min: 1, max: 5 * 1024 * 1024 })
      .withMessage("Profile photo exceeds the upload size limit."),
  ],
  validate,
  patientController.createAvatarUploadSession
);
router.post(
  "/avatar/upload-complete",
  [
    body("uploadToken")
      .trim()
      .notEmpty()
      .withMessage("Upload session expired. Please try again."),
  ],
  validate,
  patientController.completeAvatarUpload
);
router.put(
  "/profile",
  [
    body("email").optional().isEmail().withMessage("Please provide a valid email").normalizeEmail(),
    body("phone").optional().matches(/^\+\d{1,4}\d{10}$/).withMessage("Please provide a valid phone number with country code"),
    body("age").optional({ values: "falsy" }).isInt({ min: 0, max: 150 }).withMessage("Please provide a valid age"),
    body("gender").optional().isIn(["Male", "Female", "Other"]).withMessage("Invalid gender"),
    body("bloodGroup").optional().trim(),
    body("emergencyContact").optional().trim(),
    body("address").optional().trim(),
    body("height").optional().trim(),
    body("weight").optional().trim(),
    body("allergies").optional().trim(),
    body("avatar").optional().trim()
  ],
  validate,
  patientController.updateProfile
);

router.get("/receipts", patientController.getPatientReceipts);
router.get(
  "/receipts/:id/download",
  [param("id").isMongoId().withMessage("Invalid receipt id")],
  validate,
  patientController.getPatientReceiptDownload
);

// ─── Reports Routes ───────────────────────────────────────────────────────────
router.post(
  "/reports/upload-session",
  [
    body("contentType")
      .trim()
      .notEmpty()
      .withMessage("Upload content type is required."),
    body("fileSize")
      .isInt({ min: 1, max: 50 * 1024 * 1024 })
      .withMessage("Report file size must be between 1 byte and 50 MB."),
    body("fileName")
      .optional({ values: "falsy" })
      .trim()
      .isLength({ max: 255 })
      .withMessage("File name is too long."),
  ],
  validate,
  patientController.createReportUploadSession
);

router.post(
  "/reports/upload-complete",
  [
    body("uploadToken")
      .trim()
      .notEmpty()
      .withMessage("Upload token is required."),
  ],
  validate,
  patientController.completeReportUpload
);

router.get("/reports", patientController.getReports);

router.get(
  "/reports/:id/download",
  [param("id").isMongoId().withMessage("Invalid report id")],
  validate,
  patientController.getReportDownload
);

router.delete(
  "/reports/:id",
  [param("id").isMongoId().withMessage("Invalid report id")],
  validate,
  patientController.deleteReport
);

// ─── Payments Routes ──────────────────────────────────────────────────────────
router.post(
  "/payments/create-order",
  [
    body("planType")
      .trim()
      .isIn(["prescription", "report"])
      .withMessage("Plan type must be either prescription or report."),
    body("planName")
      .trim()
      .notEmpty()
      .withMessage("Plan name is required."),
  ],
  validate,
  paymentController.createOrder
);

router.post(
  "/payments/verify-payment",
  [
    body("razorpay_order_id").trim().notEmpty().withMessage("Order ID is required."),
    body("razorpay_payment_id").trim().notEmpty().withMessage("Payment ID is required."),
    body("razorpay_signature").trim().notEmpty().withMessage("Signature is required."),
  ],
  validate,
  paymentController.verifyPayment
);

router.get("/payments/history", paymentController.getPaymentHistory);

// ─── Patient Admissions & Discharges Endpoints ────────────────────────────────
router.get("/admissions", admissionController.getPatientAdmissions);
router.get(
  "/admissions/:id/slip",
  [param("id").isMongoId().withMessage("Invalid admission ID")],
  validate,
  admissionController.getPatientSlip
);
router.get("/discharges", dischargeController.getPatientDischarges);

module.exports = router;
