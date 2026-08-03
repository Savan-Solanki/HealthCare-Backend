const mongoose = require("mongoose");

const appointmentSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: [true, "Hospital is required"],
      index: true,
    },
    patientUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PatientUser",
      default: null,
      index: true,
    },
    patientRecordId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Patient",
      default: null,
      index: true,
    },
    patientFirstName: {
      type: String,
      trim: true,
      default: null,
      maxlength: [80, "First name cannot exceed 80 characters"],
    },
    patientLastName: {
      type: String,
      trim: true,
      default: null,
      maxlength: [80, "Last name cannot exceed 80 characters"],
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
    doctorName: {
      type: String,
      required: [true, "Doctor name is required"],
      trim: true,
    },
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Doctor",
      default: null,
      index: true,
    },
    department: {
      type: String,
      trim: true,
      default: null,
    },
    appointmentDate: {
      type: Date,
      required: [true, "Appointment date is required"],
    },
    appointmentTime: {
      type: String,
      trim: true,
      default: null,
    },
    status: {
      type: String,
      enum: ["Scheduled", "Confirmed", "Completed", "Cancelled", "Admitted"],
      default: "Scheduled",
    },
    isAdmitted: {
      type: Boolean,
      default: false,
    },
    consultationFee: {
      type: Number,
      min: [0, "Consultation fee cannot be negative"],
      default: 0,
    },
    paymentStatus: {
      type: String,
      enum: ["Pending", "Paid"],
      default: "Pending",
    },
    paymentMethod: {
      type: String,
      enum: ["Cash", "Card", "UPI", "Insurance"],
      default: "Cash",
    },
    appointmentPurpose: {
      type: String,
      trim: true,
      default: null,
      maxlength: [160, "Appointment purpose cannot exceed 160 characters"],
    },
    description: {
      type: String,
      trim: true,
      default: null,
      maxlength: [1200, "Description cannot exceed 1200 characters"],
    },
  },
  {
    timestamps: true,
  }
);

appointmentSchema.index({ hospitalId: 1, appointmentDate: -1, status: 1 });
appointmentSchema.index({ patientUserId: 1, appointmentDate: -1, status: 1 });
appointmentSchema.index({ hospitalId: 1, doctorName: 1, appointmentDate: 1, appointmentTime: 1 });
appointmentSchema.index({ patientName: "text", doctorName: "text", department: "text" });

module.exports = mongoose.model("Appointment", appointmentSchema);
