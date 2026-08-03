const mongoose = require("mongoose");

const staffSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: [true, "Hospital is required"],
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
    department: {
      type: String,
      enum: ["Administration", "Nursing", "Support"],
      required: [true, "Department is required"],
    },
    role: {
      type: String,
      required: [true, "Role is required"],
      trim: true,
    },
    shift: {
      type: String,
      enum: ["Day", "Night", "Rotating"],
      required: [true, "Shift is required"],
    },
    joiningDate: {
      type: Date,
      default: null,
    },
    salary: {
      type: Number,
      min: [0, "Salary cannot be negative"],
      default: 0,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },
    phoneNumber: {
      type: String,
      trim: true,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

staffSchema.index({ hospitalId: 1, department: 1, shift: 1 });
staffSchema.index({ firstName: "text", lastName: "text", email: "text", role: "text" });

module.exports = mongoose.model("Staff", staffSchema);
