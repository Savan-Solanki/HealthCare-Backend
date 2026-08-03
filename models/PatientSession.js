const mongoose = require("mongoose");

const patientSessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PatientUser",
      required: true,
      index: true,
    },
    deviceId: {
      type: String,
      required: true,
    },
    deviceName: {
      type: String,
      required: true,
    },
    deviceType: {
      type: String,
      required: true,
    },
    browserVersion: {
      type: String,
      default: "Unknown",
    },
    sessionToken: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    loginTime: {
      type: Date,
      default: Date.now,
    },
    lastActive: {
      type: Date,
      default: Date.now,
    },
    ipAddress: {
      type: String,
      default: "",
    },
    location: {
      type: String,
      default: "",
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

patientSessionSchema.index({ userId: 1, deviceId: 1 }, { unique: true });

module.exports = mongoose.model("PatientSession", patientSessionSchema);
