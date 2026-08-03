const mongoose = require("mongoose");

const rateLimitViolationSchema = new mongoose.Schema(
  {
    identifier: {
      type: String,
      required: true,
      index: true,
    },
    identifierType: {
      type: String,
      enum: ["userId", "ip", "deviceFingerprint"],
      required: true,
    },
    endpoint: {
      type: String,
      required: true,
    },
    method: {
      type: String,
      required: true,
    },
    requestCount: {
      type: Number,
      required: true,
    },
    windowMs: {
      type: Number,
      required: true,
    },
    blockedUntil: {
      type: Date,
      default: null,
      index: true,
    },
    userAgent: {
      type: String,
      default: null,
    },
    ip: {
      type: String,
      default: null,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    patientUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PatientUser",
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// TTL index to automatically clear rate limit logs after 90 days (7776000 seconds)
rateLimitViolationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });

module.exports = mongoose.model("RateLimitViolation", rateLimitViolationSchema);
