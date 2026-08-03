const mongoose = require("mongoose");

const departmentSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: [true, "Hospital is required"],
      index: true,
    },
    departmentName: {
      type: String,
      required: [true, "Department name is required"],
      trim: true,
    },
    departmentHead: {
      type: String,
      required: [true, "Department head is required"],
      trim: true,
    },
    totalStaff: {
      type: Number,
      required: [true, "Total staff is required"],
      min: [0, "Total staff cannot be negative"],
    },
  },
  {
    timestamps: true,
  }
);

departmentSchema.index({ hospitalId: 1, departmentName: 1 }, { unique: true });
departmentSchema.index({ departmentName: "text", departmentHead: "text" });

module.exports = mongoose.model("Department", departmentSchema);
