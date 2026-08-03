const mongoose = require("mongoose");

const doctorSlotSchema = new mongoose.Schema(
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
    date: {
      type: String, // "YYYY-MM-DD"
      required: [true, "Date is required"],
      trim: true,
    },
    slotTime: {
      type: String, // "HH:mm" (24h format)
      required: [true, "Slot time is required"],
      trim: true,
    },
    status: {
      type: String,
      enum: ["Available", "Booked", "Completed", "Cancelled", "Blocked", "Doctor On Leave"],
      default: "Available",
      index: true,
    },
    appointmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Appointment",
      default: null,
      index: true,
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

// Enforce unique slot per doctor, date, and time
doctorSlotSchema.index({ doctorId: 1, date: 1, slotTime: 1 }, { unique: true });

module.exports = mongoose.model("DoctorSlot", doctorSlotSchema);
