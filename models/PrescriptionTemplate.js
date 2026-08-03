const mongoose = require("mongoose");

const medicineSchema = new mongoose.Schema(
  {
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
  },
  { _id: false }
);

const prescriptionTemplateSchema = new mongoose.Schema(
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
    templateName: {
      type: String,
      required: [true, "Template name is required"],
      trim: true,
      maxlength: [120, "Template name cannot exceed 120 characters"],
    },
    diagnosis: {
      type: String,
      trim: true,
      default: "",
    },
    medicines: {
      type: [medicineSchema],
      default: [],
    },
    instruction: {
      type: String,
      trim: true,
      default: "",
    },
    isFavorite: {
      type: Boolean,
      default: false,
      index: true,
    },
    useCount: {
      type: Number,
      default: 0,
      min: 0,
      index: true,
    },
    lastUsedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient queries
prescriptionTemplateSchema.index({ doctorUserId: 1, createdAt: -1 });
prescriptionTemplateSchema.index({ doctorUserId: 1, useCount: -1 });
prescriptionTemplateSchema.index({ doctorUserId: 1, isFavorite: 1 });
prescriptionTemplateSchema.index({ templateName: "text", diagnosis: "text" });

module.exports = mongoose.model("PrescriptionTemplate", prescriptionTemplateSchema);
