const mongoose = require("mongoose");

const admissionSchema = new mongoose.Schema(
  {
    admissionId: {
      type: String,
      required: [true, "Admission ID is required"],
      unique: true,
      index: true,
    },
    patientRecordId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Patient",
      required: [true, "Patient record reference is required"],
      index: true,
    },
    patientName: {
      type: String,
      required: [true, "Patient name is required"],
      trim: true,
    },
    patientEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },
    patientPhone: {
      type: String,
      trim: true,
      default: null,
    },
    appointmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Appointment",
      required: [true, "Appointment reference is required"],
      index: true,
    },
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Doctor",
      required: [true, "Doctor reference is required"],
      index: true,
    },
    doctorName: {
      type: String,
      required: [true, "Doctor name is required"],
      trim: true,
    },
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: [true, "Hospital reference is required"],
      index: true,
    },
    department: {
      type: String,
      trim: true,
      default: null,
    },
    admissionDate: {
      type: Date,
      required: [true, "Admission date is required"],
      default: Date.now,
    },
    admittedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Staff user reference is required"],
    },
    admittedByRole: {
      type: String,
      required: [true, "Staff user role is required"],
      trim: true,
    },
    admissionReason: {
      type: String,
      required: [true, "Admission reason is required"],
      trim: true,
      maxlength: [1000, "Admission reason cannot exceed 1000 characters"],
    },
    roomNumber: {
      type: String,
      trim: true,
      default: null,
    },
    bedNumber: {
      type: String,
      trim: true,
      default: null,
    },
    notes: {
      type: String,
      trim: true,
      default: null,
    },
    status: {
      type: String,
      enum: ["Admitted", "Under Treatment", "Critical", "Stable", "Discharged"],
      default: "Admitted",
      index: true,
    },
    dischargeDate: {
      type: Date,
      default: null,
    },
    totalBill: {
      type: Number,
      default: 0,
      min: [0, "Total bill cannot be negative"],
    },
    auditLogs: [
      {
        action: { type: String, required: true },
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

// Indexes for searching
admissionSchema.index({ hospitalId: 1, status: 1, admissionDate: -1 });
admissionSchema.index({ patientName: "text", doctorName: "text", admissionId: "text" });

module.exports = mongoose.model("Admission", admissionSchema);
