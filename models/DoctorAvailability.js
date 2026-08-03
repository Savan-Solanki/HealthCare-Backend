const mongoose = require("mongoose");

const doctorAvailabilitySchema = new mongoose.Schema(
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
      required: [true, "Doctor is required"],
      index: true,
    },
    dayOfWeek: {
      type: Number, // 0 for Sunday, 1 for Monday, ..., 6 for Saturday
      required: [true, "Day of week is required"],
      min: 0,
      max: 6,
    },
    startTime: {
      type: String, // "HH:mm" (24h format)
      required: [true, "Start time is required"],
      trim: true,
    },
    endTime: {
      type: String, // "HH:mm" (24h format)
      required: [true, "End time is required"],
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compounded index for quick availability lookup
doctorAvailabilitySchema.index({ doctorId: 1, dayOfWeek: 1 });

module.exports = mongoose.model("DoctorAvailability", doctorAvailabilitySchema);
