const express = require("express");
const { body } = require("express-validator");
const router = express.Router();

const patientAuthController = require("../controllers/patientAuthController");
const { protectPatient } = require("../middleware/auth");
const validate = require("../middleware/validate");

// ─── Validation Rules ──────────────────────────────────────────────────────────
const registerRules = [
  body("fullName").trim().notEmpty().withMessage("Full name is required").isLength({ min: 2 }),
  body("email").isEmail().withMessage("Valid email is required").normalizeEmail(),
  body("password")
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters")
    .matches(/\d/)
    .withMessage("Password must contain a number"),
  body("mobile")
    .trim()
    .notEmpty()
    .withMessage("Mobile number is required")
    .matches(/^\+\d{1,4}\d{10}$/)
    .withMessage("Mobile number must include country code and 10-digit number"),
  body("turnstileToken").notEmpty().withMessage("Captcha verification is required"),
];

const loginRules = [
  body("email").isEmail().withMessage("Valid email is required").normalizeEmail(),
  body("password").notEmpty().withMessage("Password is required"),
  body("turnstileToken").notEmpty().withMessage("Captcha verification is required"),
];

const googleLoginRules = [
  body("credential").notEmpty().withMessage("Google credential is required"),
];

const googleMobileRules = [
  body("credential").notEmpty().withMessage("Google credential is required"),
  body("mobile")
    .trim()
    .notEmpty()
    .withMessage("Mobile number is required")
    .matches(/^\+\d{1,4}\d{10}$/)
    .withMessage("Mobile number must include country code and 10-digit number"),
  body("password")
    .optional()
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters")
    .matches(/\d/)
    .withMessage("Password must contain a number"),
];

const addMobileRules = [
  body("email").isEmail().withMessage("Valid email is required").normalizeEmail(),
  body("mobile")
    .trim()
    .notEmpty()
    .withMessage("Mobile number is required")
    .matches(/^\+\d{1,4}\d{10}$/)
    .withMessage("Mobile number must include country code and 10-digit number"),
];

const verifyOtpRules = [
  body("mobile").notEmpty().withMessage("Mobile number is required"),
  body("otp").notEmpty().withMessage("OTP is required"),
];

const verifyGoogleOtpRules = [
  body("credential").notEmpty().withMessage("Google credential is required"),
  body("mobile").notEmpty().withMessage("Mobile number is required"),
  body("otp").notEmpty().withMessage("OTP is required"),
];

const resendOtpRules = [
  body("mobile").notEmpty().withMessage("Mobile number is required"),
];

const resendGoogleOtpRules = [
  body("credential").notEmpty().withMessage("Google credential is required"),
];

const forgotPasswordRules = [
  body("email").isEmail().withMessage("Valid email is required").normalizeEmail(),
];

const resendPasswordResetRules = [
  body("email").isEmail().withMessage("Valid email is required").normalizeEmail(),
];

const resetPasswordRules = [
  body("email").isEmail().withMessage("Valid email is required").normalizeEmail(),
  body("otp").notEmpty().withMessage("OTP is required"),
  body("newPassword")
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters")
    .matches(/\d/)
    .withMessage("Password must contain a number"),
];

// ─── Public Patient Routes ───────────────────────────────────────────────────
router.post("/register", registerRules, validate, patientAuthController.register);
router.post("/login", loginRules, validate, patientAuthController.login);
router.post("/google-login", googleLoginRules, validate, patientAuthController.googleLogin);
router.post("/google-mobile", googleMobileRules, validate, patientAuthController.googleMobile);
router.post("/add-mobile", addMobileRules, validate, patientAuthController.addMobile);
router.post("/forgot-password", forgotPasswordRules, validate, patientAuthController.forgotPassword);
router.post("/resend-password-reset", resendPasswordResetRules, validate, patientAuthController.resendPasswordResetOtp);
router.post("/reset-password", resetPasswordRules, validate, patientAuthController.resetPassword);

// Fallbacks for client OTP UI steps (mock verified automatically)
router.post("/verify-otp", verifyOtpRules, validate, patientAuthController.verifyOtp);
router.post("/verify-google-otp", verifyGoogleOtpRules, validate, patientAuthController.verifyGoogleOtp);
router.post("/resend-google-otp", resendGoogleOtpRules, validate, patientAuthController.resendGoogleOtp);
router.post("/resend-otp", resendOtpRules, validate, patientAuthController.resendOtp);

router.get("/refresh", (req, res) => {
  res.status(405).json({
    success: false,
    message: "Patient token refresh requires POST /api/v1/patient/auth/refresh with credentials.",
    methodRequired: "POST",
  });
});
router.post("/refresh", patientAuthController.refresh);
router.post("/logout", patientAuthController.logout);

// ─── Protected Patient Routes ─────────────────────────────────────────────────
router.get("/me", protectPatient, patientAuthController.getMe);

// ─── Multi-account routes ─────────────────────────────────────────────────────
router.get("/linked-accounts", protectPatient, patientAuthController.getLinkedAccounts);

router.post(
  "/switch-account",
  protectPatient,
  [
    body("targetAccountId").isMongoId().withMessage("Invalid account ID."),
  ],
  validate,
  patientAuthController.switchAccount
);

router.post(
  "/add-account",
  protectPatient,
  [
    body("name").trim().notEmpty().withMessage("Name is required.").isLength({ max: 100 }),
    body("email").isEmail().withMessage("Valid email is required.").normalizeEmail(),
    body("password").isLength({ min: 8 }).withMessage("Password must be at least 8 characters.").matches(/\d/).withMessage("Password must contain at least one digit."),
  ],
  validate,
  patientAuthController.addAccount
);

router.post(
  "/google-add-account",
  protectPatient,
  [
    body("credential").notEmpty().withMessage("Google credential is required."),
  ],
  validate,
  patientAuthController.googleAddAccount
);

router.post(
  "/google-complete-add-account",
  protectPatient,
  [
    body("credential").notEmpty().withMessage("Google credential is required."),
    body("password").isLength({ min: 8 }).withMessage("Password must be at least 8 characters.").matches(/\d/).withMessage("Password must contain at least one digit."),
  ],
  validate,
  patientAuthController.googleCompleteAddAccount
);

router.patch(
  "/update-account-label",
  protectPatient,
  [
    body("label").trim().isLength({ max: 40 }).withMessage("Label cannot exceed 40 characters."),
  ],
  validate,
  patientAuthController.updateAccountLabel
);

router.post("/heartbeat", protectPatient, patientAuthController.heartbeat);

router.get("/sessions", protectPatient, patientAuthController.getSessions);
router.delete("/sessions/:deviceId", protectPatient, patientAuthController.terminateSession);

module.exports = router;
