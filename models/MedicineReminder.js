const mongoose = require("mongoose");

const TIME_FORMAT = /^([01]\d|2[0-3]):[0-5]\d$/;

const medicineReminderSchema = new mongoose.Schema(
  {
    patientUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PatientUser",
      required: [true, "Patient user is required"],
      index: true,
    },
    prescriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Prescription",
      default: null,
    },
    type: {
      type: String,
      enum: ["doctor_prescription", "patient_custom"],
      required: [true, "Reminder type is required"],
      index: true,
    },
    medicineName: {
      type: String,
      required: [true, "Medicine name is required"],
      trim: true,
      maxlength: [200, "Medicine name cannot exceed 200 characters"],
    },
    dosage: {
      type: String,
      required: [true, "Dosage is required"],
      trim: true,
      maxlength: [100, "Dosage cannot exceed 100 characters"],
    },
    frequency: {
      type: String,
      trim: true,
      default: "",
    },
    startDate: {
      type: Date,
      required: [true, "Start date is required"],
    },
    endDate: {
      type: Date,
      // Optional — defaults to 1 year from startDate if not provided
      default: null,
    },
    times: {
      type: [String],
      default: [],
      validate: {
        validator: function validateTimes(values) {
          return values.every((v) => TIME_FORMAT.test(v));
        },
        message: "Each time must be in HH:mm format (00:00–23:59)",
      },
    },
    status: {
      type: String,
      enum: ["active", "paused", "completed", "cancelled"],
      default: "active",
      index: true,
    },
    doctorName: {
      type: String,
      trim: true,
      default: "",
    },
    hospitalName: {
      type: String,
      trim: true,
      default: "",
    },
    // ── Extended fields ─────────────────────────────────────────────
    notes: {
      type: String,
      trim: true,
      default: "",
      maxlength: [500, "Notes cannot exceed 500 characters"],
    },
    /**
     * Repeat type for the reminder:
     *   daily         — fires every day at the listed times
     *   weekly        — fires on specific days of the week (see repeatDays)
     *   custom_days   — fires on a custom selection of weekdays (see repeatDays)
     *   every_x_hours — fires every N hours starting from the first listed time
     */
    repeatType: {
      type: String,
      enum: ["daily", "weekly", "custom_days", "every_x_hours"],
      default: "daily",
    },
    /**
     * Days of the week on which the reminder fires.
     * 0 = Sunday, 1 = Monday … 6 = Saturday.
     * Used when repeatType is "weekly" or "custom_days".
     */
    repeatDays: {
      type: [Number],
      default: [],
      validate: {
        validator: (vals) => vals.every((d) => Number.isInteger(d) && d >= 0 && d <= 6),
        message: "repeatDays values must be integers between 0 (Sun) and 6 (Sat)",
      },
    },
    /**
     * Interval in hours between reminders.
     * Used when repeatType is "every_x_hours".
     */
    repeatIntervalHours: {
      type: Number,
      min: [1, "Repeat interval must be at least 1 hour"],
      max: [24, "Repeat interval cannot exceed 24 hours"],
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for common query patterns
medicineReminderSchema.index({ patientUserId: 1, status: 1, endDate: 1 });
medicineReminderSchema.index({ status: 1, endDate: 1 });
medicineReminderSchema.index({ status: 1, times: 1 });
medicineReminderSchema.index({ prescriptionId: 1, status: 1 });

module.exports = mongoose.model("MedicineReminder", medicineReminderSchema);
