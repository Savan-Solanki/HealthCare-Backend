const mongoose = require("mongoose");

const doctorMedicineSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: [true, "Hospital is required"],
      index: true,
    },
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Doctor",
      default: null,
      index: true,
    },
    doctorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Doctor user is required"],
      index: true,
    },
    medicineName: {
      type: String,
      required: [true, "Medicine name is required"],
      trim: true,
    },
    dosage: {
      type: String,
      required: [true, "Dosage is required"],
      trim: true,
    },
    frequency: {
      type: String,
      required: [true, "Frequency is required"],
      trim: true,
    },
    duration: {
      type: String,
      required: [true, "Duration is required"],
      trim: true,
    },
    schedule: {
      morning: { type: Boolean, default: false },
      afternoon: { type: Boolean, default: false },
      night: { type: Boolean, default: false },
      morningTime: { type: String, trim: true, default: "" },
      afternoonTime: { type: String, trim: true, default: "" },
      nightTime: { type: String, trim: true, default: "" },
    },
    useCount: {
      type: Number,
      default: 1,
      min: 0,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index to prevent duplicate medicine config entries per doctor
doctorMedicineSchema.index(
  { doctorUserId: 1, medicineName: 1, dosage: 1, frequency: 1, duration: 1 },
  { unique: true }
);
doctorMedicineSchema.index({ doctorUserId: 1, useCount: -1 });

module.exports = mongoose.model("DoctorMedicine", doctorMedicineSchema);
