const mongoose = require("mongoose");

const notificationLogSchema = new mongoose.Schema(
  {
    reminderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MedicineReminder",
      index: true,
    },
    patientUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PatientUser",
      required: [true, "Patient user is required"],
      index: true,
    },
    scheduledFor: {
      type: Date,
    },
    sentAt: {
      type: Date,
      default: Date.now,
    },
    status: {
      type: String,
      enum: ["sent", "failed", "skipped"],
      required: [true, "Notification status is required"],
      index: true,
    },
    fcmMessageId: {
      type: String,
      default: null,
    },
    errorMessage: {
      type: String,
      default: null,
    },
    title: {
      type: String,
      required: [true, "Notification title is required"],
      trim: true,
      maxlength: [200, "Title cannot exceed 200 characters"],
    },
    body: {
      type: String,
      required: [true, "Notification body is required"],
      trim: true,
      maxlength: [500, "Body cannot exceed 500 characters"],
    },
    category: {
      type: String,
      enum: ["medicine_reminder", "prescription", "appointment", "system"],
      required: [true, "Notification category is required"],
      index: true,
    },
    actionUrl: {
      type: String,
      default: "/dashboard",
    },
    isRead: {
      type: Boolean,
      default: false,
      index: true,
    },
    readAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Prevents duplicate notifications for the same reminder + scheduled time
notificationLogSchema.index(
  { reminderId: 1, scheduledFor: 1 },
  { unique: true, sparse: true }
);

// Patient inbox — most recent first
notificationLogSchema.index({ patientUserId: 1, createdAt: -1 });

// Unread count queries
notificationLogSchema.index({ patientUserId: 1, isRead: 1 });

// Admin / monitoring queries
notificationLogSchema.index({ status: 1, createdAt: -1 });

// Auto-delete logs older than 7 days
notificationLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 7 * 24 * 60 * 60 }
);

module.exports = mongoose.model("NotificationLog", notificationLogSchema);
