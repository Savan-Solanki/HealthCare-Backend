const mongoose = require("mongoose");

const dischargeSummarySchema = new mongoose.Schema(
  {
    dischargeId: {
      type: String,
      required: [true, "Discharge ID is required"],
      unique: true,
      index: true,
    },
    admissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admission",
      required: [true, "Admission reference is required"],
      index: true,
    },
    appointmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Appointment",
      required: [true, "Appointment reference is required"],
    },
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Patient",
      required: [true, "Patient reference is required"],
      index: true,
    },
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: [true, "Hospital reference is required"],
      index: true,
    },
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Doctor",
      required: [true, "Doctor reference is required"],
      index: true,
    },
    // Patient Snapshot
    patientName: { type: String, required: true },
    patientAge: { type: Number, default: null },
    patientGender: { type: String, default: null },
    patientBloodGroup: { type: String, default: null },
    patientPhone: { type: String, default: null },
    patientAddress: { type: String, default: null },
    // Hospital Snapshot
    hospitalName: { type: String, required: true },
    hospitalLogoUrl: { type: String, default: null },
    hospitalAddress: { type: String, default: null },
    hospitalPhone: { type: String, default: null },
    hospitalEmail: { type: String, default: null },
    hospitalRegistrationNumber: { type: String, default: null },
    // Doctor Snapshot
    doctorName: { type: String, required: true },
    doctorDepartment: { type: String, default: null },
    doctorRegistrationNumber: { type: String, default: null },
    // Clinical Content
    diagnosis: {
      type: String,
      required: [true, "Diagnosis is required"],
      trim: true,
    },
    historyAndClinicalSummary: {
      type: String,
      trim: true,
      default: null,
    },
    treatmentGiven: {
      type: String,
      trim: true,
      default: null,
    },
    investigations: {
      type: String,
      trim: true,
      default: null,
    },
    surgeryProcedureName: {
      type: String,
      trim: true,
      default: null,
    },
    surgeryDate: {
      type: Date,
      default: null,
    },
    surgeonName: {
      type: String,
      trim: true,
      default: null,
    },
    anesthesiologistName: {
      type: String,
      trim: true,
      default: null,
    },
    surgicalNotes: {
      type: String,
      trim: true,
      default: null,
    },
    conditionOnDischarge: {
      type: String,
      trim: true,
      default: null,
    },
    hospitalCourseSummary: {
      type: String,
      trim: true,
      default: null,
    },
    // Admissions details Snapshot
    admissionDate: { type: Date, required: true },
    dischargeDate: { type: Date, required: true },
    dischargeType: {
      type: String,
      enum: ["Regular", "LAMA", "Referred", "Expired", "Absconded"],
      default: "Regular",
    },
    roomNumber: { type: String, default: null },
    bedNumber: { type: String, default: null },
    // Continuing Medications
    medications: [
      {
        medicineName: { type: String, required: true },
        dose: { type: String, default: "" },
        frequency: { type: String, default: "" },
        duration: { type: String, default: "" },
      },
    ],
    // Follow-up
    followUpDate: { type: Date, default: null },
    followUpInstructions: { type: String, trim: true, default: null },
    // S3 Storage File Details
    pdfUrl: { type: String, default: null },
    s3Key: { type: String, default: null },
    isDraft: {
      type: Boolean,
      default: false,
      index: true,
    },
    generatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    generatedByName: { type: String, required: true },
    generatedAt: {
      type: Date,
      default: Date.now,
    },
    auditLogs: [
      {
        action: { type: String, required: true }, // e.g. "DOWNLOADED", "PRINTED"
        details: { type: String, default: "" },
        date: { type: Date, default: Date.now },
        performedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        performedByName: { type: String, default: "System" },
      },
    ],
  },
  {
    timestamps: true,
  }
);

// Indexes
dischargeSummarySchema.index({ hospitalId: 1, dischargeDate: -1 });
dischargeSummarySchema.index({ patientId: 1, dischargeDate: -1 });
dischargeSummarySchema.index({ patientName: "text", doctorName: "text", dischargeId: "text" });

module.exports = mongoose.model("DischargeSummary", dischargeSummarySchema);
