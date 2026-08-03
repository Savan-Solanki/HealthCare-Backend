const mongoose = require("mongoose");

const patientSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: [true, "Hospital is required"],
      index: true,
    },
    firstName: {
      type: String,
      required: [true, "First name is required"],
      trim: true,
    },
    lastName: {
      type: String,
      required: [true, "Last name is required"],
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },
    phone: {
      type: String,
      trim: true,
      default: null,
    },
    emergencyContact: {
      type: String,
      trim: true,
      default: null,
    },
    age: {
      type: Number,
      min: [0, "Age cannot be negative"],
      default: null,
    },
    bloodGroup: {
      type: String,
      trim: true,
      default: null,
    },
    gender: {
      type: String,
      enum: ["Male", "Female", "Other"],
      default: null,
    },
    status: {
      type: String,
      enum: ["Active", "Inactive"],
      default: "Active",
    },
    address: {
      type: String,
      trim: true,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

patientSchema.index({ hospitalId: 1, status: 1 });
patientSchema.index({ firstName: "text", lastName: "text", email: "text", phone: "text" });

module.exports = mongoose.model("Patient", patientSchema);
