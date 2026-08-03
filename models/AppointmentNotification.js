const mongoose = require("mongoose");

const appointmentNotificationSchema = new mongoose.Schema(
  {
    appointmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Appointment",
      required: [true, "Appointment is required"],
      index: true,
    },
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: [true, "Hospital is required"],
      index: true,
    },
    targetRole: {
      type: String,
      enum: ["Hospital Admin", "Doctor", "Receptionist"],
      required: [true, "Notification target role is required"],
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
      default: null,
      index: true,
    },
    doctorName: {
      type: String,
      trim: true,
      default: null,
      index: true,
    },
    patientName: {
      type: String,
      trim: true,
      required: [true, "Patient name is required"],
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
    title: {
      type: String,
      trim: true,
      required: [true, "Notification title is required"],
    },
    message: {
      type: String,
      trim: true,
      required: [true, "Notification message is required"],
    },
    actionUrl: {
      type: String,
      trim: true,
      required: [true, "Notification action URL is required"],
    },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  },
  {
    timestamps: true,
  }
);

appointmentNotificationSchema.index({ hospitalId: 1, targetRole: 1, createdAt: -1 });
appointmentNotificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("AppointmentNotification", appointmentNotificationSchema);
