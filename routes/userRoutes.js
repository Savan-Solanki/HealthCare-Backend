const express = require("express");
const { body, param } = require("express-validator");
const router = express.Router();

const userController = require("../controllers/userController");
const { protect, restrictTo } = require("../middleware/auth");
const validate = require("../middleware/validate");

// All user routes require authentication
router.use(protect);
router.use(restrictTo("Super Admin"));

// ─── Validation Rules ──────────────────────────────────────────────────────────
const createUserRules = [
  body("name").trim().notEmpty().withMessage("Name is required"),
  body("email").isEmail().withMessage("Valid email is required").normalizeEmail(),
  body("password")
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters"),
  body("role")
    .optional()
    .isIn(["Hospital Admin", "Receptionist"])
    .withMessage("Only Hospital Admin and Receptionist accounts can be created here"),
  body("status")
    .optional()
    .isIn(["Active", "Inactive", "On Leave", "Suspended"])
    .withMessage("Invalid status"),
  body("hospitalId").optional().isMongoId().withMessage("Hospital is invalid"),
  body("accessType")
    .optional()
    .isIn(["permanent", "demo"])
    .withMessage("Access type must be permanent or demo"),
  body("demoDays")
    .optional({ values: "falsy" })
    .isInt({ min: 1, max: 365 })
    .withMessage("Demo duration must be between 1 and 365 days"),
];

const updateUserRules = [
  body("name").optional().trim().notEmpty().withMessage("Name is required"),
  body("email")
    .optional()
    .isEmail()
    .withMessage("Valid email is required")
    .normalizeEmail(),
  body("role")
    .optional()
    .isIn(["Super Admin", "Hospital Admin", "Doctor", "Nurse", "Receptionist", "Staff"])
    .withMessage("Invalid role"),
  body("status")
    .optional()
    .isIn(["Active", "Inactive", "On Leave", "Suspended"])
    .withMessage("Invalid status"),
  body("hospitalId").optional().isMongoId().withMessage("Hospital is invalid"),
  body("accessType")
    .optional()
    .isIn(["permanent", "demo"])
    .withMessage("Access type must be permanent or demo"),
  body("demoDays")
    .optional({ values: "falsy" })
    .isInt({ min: 1, max: 365 })
    .withMessage("Demo duration must be between 1 and 365 days"),
];
router
  .route("/")
  .get(userController.getAllUsers)
  .post(createUserRules, validate, userController.createUser);

router
  .route("/:id")
  .get(userController.getUserById)
  .put(updateUserRules, validate, userController.updateUser)
  .delete(userController.deleteUser);

router.patch(
  "/:id/toggle-status",
  userController.toggleUserStatus
);

// ─── Patient Admin Routes ────────────────────────────────────────────────────
router.get(
  "/patients/credits/welcome-bonus",
  userController.getWelcomeBonus
);

router.post(
  "/patients/credits/welcome-bonus",
  [
    body("reportCredits").isNumeric().withMessage("Report credits must be a number"),
    body("prescriptionCredits").isNumeric().withMessage("Prescription credits must be a number"),
  ],
  validate,
  userController.updateWelcomeBonus
);

router.post(
  "/patients/credits/bulk-adjust",
  [
    body("creditType").isIn(["report", "prescription"]).withMessage("Invalid credit type"),
    body("action").isIn(["add", "deduct", "reset"]).withMessage("Invalid action"),
    body("reason").trim().notEmpty().withMessage("Reason is required"),
  ],
  validate,
  userController.bulkAdjustPatientCredits
);

router.get(
  "/patients/:id/credits",
  [param("id").isMongoId().withMessage("Invalid patient ID")],
  validate,
  userController.getPatientCredits
);

router.post(
  "/patients/:id/credits/adjust",
  [
    param("id").isMongoId().withMessage("Invalid patient ID"),
    body("creditType").isIn(["report", "prescription"]).withMessage("Invalid credit type"),
    body("action").isIn(["add", "deduct", "reset"]).withMessage("Invalid action"),
    body("reason").trim().notEmpty().withMessage("Reason is required"),
  ],
  validate,
  userController.adjustPatientCredits
);

router.get(
  "/patients/:id/sessions",
  [param("id").isMongoId().withMessage("Invalid patient ID")],
  validate,
  userController.getPatientSessions
);

router.delete(
  "/patients/:id/sessions/:sessionId",
  [
    param("id").isMongoId().withMessage("Invalid patient ID"),
    param("sessionId").isMongoId().withMessage("Invalid session ID"),
  ],
  validate,
  userController.terminatePatientSession
);

module.exports = router;
