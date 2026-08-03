const express = require("express");
const { body } = require("express-validator");
const router = express.Router();

const authController = require("../controllers/authController");
const { protect } = require("../middleware/auth");
const validate = require("../middleware/validate");

// ─── Validation Rules ──────────────────────────────────────────────────────────
const registerRules = [
  body("name").trim().notEmpty().withMessage("Name is required").isLength({ min: 2 }),
  body("email").isEmail().withMessage("Valid email is required").normalizeEmail(),
  body("password")
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters")
    .matches(/\d/)
    .withMessage("Password must contain a number"),
];

const portalRule = body("portal")
  .optional()
  .isIn(["super-admin", "hospital-admin", "receptionist", "doctor"])
  .withMessage("Invalid login portal");

const loginRules = [
  body("email").isEmail().withMessage("Valid email is required").normalizeEmail(),
  body("password").notEmpty().withMessage("Password is required"),
  body("turnstileToken").notEmpty().withMessage("Captcha verification is required"),
  portalRule,
];

const verifyOtpRules = [
  body("email").isEmail().withMessage("Valid email is required").normalizeEmail(),
  body("otp").notEmpty().withMessage("OTP is required"),
  portalRule,
];

const forgotPasswordRules = [
  body("email").isEmail().withMessage("Valid email is required").normalizeEmail(),
  portalRule,
];

const resendOtpRules = [
  body("email").isEmail().withMessage("Valid email is required").normalizeEmail(),
  body("purpose").optional().isIn(["login", "password-reset"]),
  portalRule,
];

const resetPasswordRules = [
  body("email").isEmail().withMessage("Valid email is required").normalizeEmail(),
  body("otp").notEmpty().withMessage("OTP is required"),
  body("newPassword")
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters")
    .matches(/\d/)
    .withMessage("Password must contain a number"),
  portalRule,
];

// ─── Public Routes ─────────────────────────────────────────────────────────────
router.post("/register", registerRules, validate, authController.register);
router.post("/login", loginRules, validate, authController.login);
router.post("/verify-otp", verifyOtpRules, validate, authController.verifyOtp);
router.post("/resend-otp", resendOtpRules, validate, authController.resendOtp);
router.post("/forgot-password", forgotPasswordRules, validate, authController.forgotPassword);
router.post("/reset-password", resetPasswordRules, validate, authController.resetPassword);
router.get("/refresh", (req, res) => {
  res.status(405).json({
    success: false,
    message: "Token refresh requires POST /api/v1/auth/refresh with credentials (httpOnly refresh cookie).",
    methodRequired: "POST",
  });
});
router.post("/refresh", authController.refresh);
router.post("/logout", authController.logout);

// ─── Protected Routes ──────────────────────────────────────────────────────────
router.get("/me", protect, authController.getMe);

module.exports = router;
