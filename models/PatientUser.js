const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const patientUserSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
      minlength: [2, "Name must be at least 2 characters"],
      maxlength: [100, "Name cannot exceed 100 characters"],
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Please provide a valid email"],
    },
    password: {
      type: String,
      select: false,
    },
    phone: {
      type: String,
      required: [true, "Mobile number is required"],
      trim: true,
      match: [/^\+\d{1,4}\d{10}$/, "Please provide a valid phone number with country code"],
    },
    isMobileVerified: {
      type: Boolean,
      default: true,
    },
    googleId: {
      type: String,
      unique: true,
      sparse: true,
    },
    avatar: {
      type: String,
      default: null,
    },
    age: {
      type: Number,
      min: [0, "Age cannot be negative"],
      max: [150, "Age cannot exceed 150"],
      default: null,
    },
    gender: {
      type: String,
      enum: ["Male", "Female", "Other"],
      default: null,
    },
    bloodGroup: {
      type: String,
      trim: true,
      default: null,
    },
    emergencyContact: {
      type: String,
      trim: true,
      default: null,
    },
    address: {
      type: String,
      trim: true,
      default: null,
    },
    // ── Additional health fields ──
    height: {
      type: String,
      trim: true,
      default: null,
    },
    weight: {
      type: String,
      trim: true,
      default: null,
    },
    allergies: {
      type: String,
      trim: true,
      default: null,
    },
    refreshToken: {
      type: String,
      select: false,
    },
    passwordChangedAt: {
      type: Date,
      default: null,
    },
    lastLogin: {
      type: Date,
      default: null,
    },
    otpHash: {
      type: String,
      select: false,
      default: null,
    },
    otpExpires: {
      type: Date,
      select: false,
      default: null,
    },
    otpPurpose: {
      type: String,
      enum: ["password-reset", "account-setup"],
      select: false,
      default: null,
    },
    resetOtpRequestCount: {
      type: Number,
      select: false,
      default: 0,
    },
    resetOtpRequestWindowStart: {
      type: Date,
      select: false,
      default: null,
    },
    resetOtpFailedAttempts: {
      type: Number,
      select: false,
      default: 0,
    },
    resetOtpBlockedUntil: {
      type: Date,
      select: false,
      default: null,
    },
    loginFailedAttempts: {
      type: Number,
      select: false,
      default: 0,
    },
    loginBlockedUntil: {
      type: Date,
      select: false,
      default: null,
    },
    fcmToken: {
      type: String,
      default: null,
    },
    fcmTokens: {
      type: [String],
      default: [],
    },
    // ── Multi-account fields ──
    accountIndex: {
      type: Number,
      min: 0,
      max: 2,
      default: 0,
    },
    lastActiveAt: {
      type: Date,
      default: Date.now,
    },
    accountLabel: {
      type: String,
      trim: true,
      maxlength: 40,
      default: "",
    },
    prescriptionCredits: {
      type: Number,
      default: 0,
      min: 0,
    },
    reportCredits: {
      type: Number,
      default: 0,
      min: 0,
    },
    welcomeCreditsGranted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// ── Compound unique index: one phone can have up to 3 accounts (index 0–2) ──
patientUserSchema.index({ phone: 1, accountIndex: 1 }, { unique: true });

// Pre-save: hash password if modified
patientUserSchema.pre("save", async function (next) {
  if (!this.password || !this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Compare password
patientUserSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model("PatientUser", patientUserSchema);
