const mongoose = require("mongoose");

const doctorSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: [true, "Hospital is required"],
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    firstName: {
      type: String,
      required: [true, "First name is required"],
      trim: true,
    },
    lastName: {
      type: String,
      required: [true, "Last name is required"],
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },
    phone: {
      type: String,
      trim: true,
      default: null,
    },
    availableTime: {
      type: String,
      trim: true,
      default: null,
    },
    consultationFee: {
      type: Number,
      min: [0, "Consultation fee cannot be negative"],
      default: 0,
    },
    specialization: {
      type: String,
      trim: true,
      default: null,
    },
    experience: {
      type: String,
      trim: true,
      default: null,
    },
    gender: {
      type: String,
      enum: ["Male", "Female"],
      default: null,
    },
    qualification: {
      type: String,
      trim: true,
      default: null,
    },
    department: {
      type: String,
      trim: true,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

doctorSchema.index({ hospitalId: 1, specialization: 1, department: 1 });
doctorSchema.index({ firstName: "text", lastName: "text", email: "text", specialization: "text", department: "text" });

module.exports = mongoose.model("Doctor", doctorSchema);
