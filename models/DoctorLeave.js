const mongoose = require("mongoose");

const doctorLeaveSchema = new mongoose.Schema(
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
    leaveType: {
      type: String,
      enum: ["Single Day Leave", "Multiple Day Leave", "Half-Day Leave", "Emergency Leave"],
      required: [true, "Leave type is required"],
    },
    startDate: {
      type: String, // "YYYY-MM-DD"
      required: [true, "Start date is required"],
      trim: true,
    },
    endDate: {
      type: String, // "YYYY-MM-DD"
      required: [true, "End date is required"],
      trim: true,
    },
    halfDayOption: {
      type: String, // "First Half", "Second Half"
      enum: ["First Half", "Second Half", null],
      default: null,
    },
    reason: {
      type: String,
      trim: true,
      default: null,
    },
    status: {
      type: String,
      enum: ["Active", "Cancelled"],
      default: "Active",
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compounded index for quick leave check
doctorLeaveSchema.index({ doctorId: 1, startDate: 1, endDate: 1, status: 1 });

module.exports = mongoose.model("DoctorLeave", doctorLeaveSchema);
