const express = require("express");
const { body } = require("express-validator");
const router = express.Router();

const hospitalController = require("../controllers/hospitalController");
const { protect, restrictTo } = require("../middleware/auth");
const validate = require("../middleware/validate");

router.use(protect);

// ─── Validation Rules ──────────────────────────────────────────────────────────
const createHospitalRules = [
  body("name").trim().notEmpty().withMessage("Hospital name is required"),
  body("city").trim().notEmpty().withMessage("City is required"),
  body("state").trim().notEmpty().withMessage("State is required"),
  body("address").trim().notEmpty().withMessage("Address is required"),
  body("phone").trim().notEmpty().withMessage("Contact number is required"),
  body("email").isEmail().withMessage("Valid email address is required").normalizeEmail(),
  body("registrationNumber").optional().trim(),
  body("establishedYear")
    .optional()
    .isInt({ min: 1800, max: new Date().getFullYear() })
    .withMessage("Established year must be valid"),
  body("specializations")
    .optional()
    .isArray()
    .withMessage("Specializations must be an array"),
  body("beds")
    .optional()
    .isInt({ min: 0 })
    .withMessage("Beds must be a non-negative integer"),
  body("doctors")
    .optional()
    .isInt({ min: 0 })
    .withMessage("Doctors count must be a non-negative integer"),
  body("status")
    .optional()
    .isIn(["Active", "Inactive", "Under Maintenance", "Pending"])
    .withMessage("Invalid status"),
  body("type")
    .optional()
    .isIn(["Government", "Private", "Trust", "Clinic", "Multi-speciality"])
    .withMessage("Invalid type"),
];

const updateHospitalRules = [
  body("name").optional().trim().notEmpty().withMessage("Hospital name is required"),
  body("city").optional().trim().notEmpty().withMessage("City is required"),
  body("state").optional().trim().notEmpty().withMessage("State is required"),
  body("address").optional().trim().notEmpty().withMessage("Address is required"),
  body("phone").optional().trim().notEmpty().withMessage("Contact number is required"),
  body("email").optional().isEmail().withMessage("Valid email address is required").normalizeEmail(),
  body("registrationNumber").optional().trim(),
  body("establishedYear")
    .optional()
    .isInt({ min: 1800, max: new Date().getFullYear() })
    .withMessage("Established year must be valid"),
  body("specializations")
    .optional()
    .isArray()
    .withMessage("Specializations must be an array"),
  body("beds")
    .optional()
    .isInt({ min: 0 })
    .withMessage("Beds must be a non-negative integer"),
  body("doctors")
    .optional()
    .isInt({ min: 0 })
    .withMessage("Doctors count must be a non-negative integer"),
  body("status")
    .optional()
    .isIn(["Active", "Inactive", "Under Maintenance", "Pending"])
    .withMessage("Invalid status"),
  body("type")
    .optional()
    .isIn(["Government", "Private", "Trust", "Clinic", "Multi-speciality"])
    .withMessage("Invalid type"),
];

// ─── Routes ────────────────────────────────────────────────────────────────────
router
  .route("/")
  .get(hospitalController.getAllHospitals)
  .post(
    restrictTo("Super Admin"),
    createHospitalRules,
    validate,
    hospitalController.createHospital
  );

router
  .route("/:id")
  .get(hospitalController.getHospitalById)
  .put(
    restrictTo("Super Admin", "Hospital Admin"),
    updateHospitalRules,
    validate,
    hospitalController.updateHospital
  )
  .delete(restrictTo("Super Admin"), hospitalController.deleteHospital);

router.get("/:id/stats", restrictTo("Super Admin"), hospitalController.getHospitalStats);

router.post(
  "/:id/logo/upload-session",
  restrictTo("Super Admin", "Hospital Admin"),
  [
    body("contentType")
      .trim()
      .isIn(["image/jpeg", "image/png", "image/webp"])
      .withMessage("Upload a JPG, PNG, or WEBP hospital logo."),
    body("fileSize")
      .isInt({ min: 1, max: 2 * 1024 * 1024 })
      .withMessage("Hospital logo exceeds the upload size limit."),
  ],
  validate,
  hospitalController.createHospitalLogoUploadSession
);
router.post(
  "/:id/logo/upload-complete",
  restrictTo("Super Admin", "Hospital Admin"),
  [
    body("uploadToken")
      .trim()
      .notEmpty()
      .withMessage("Upload session expired. Please try again."),
  ],
  validate,
  hospitalController.completeHospitalLogoUpload
);

module.exports = router;
