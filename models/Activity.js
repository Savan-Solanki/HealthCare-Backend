const mongoose = require("mongoose");

const activitySchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: [true, "Action is required"],
      trim: true,
    },
    entity: {
      type: String,
      enum: ["User", "Hospital", "System", "Auth", "Report", "Prescription", "Transaction", "PatientUser"],
      required: true,
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    userName: {
      type: String,
      default: "System",
    },
    userRole: {
      type: String,
      default: null,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    ip: {
      type: String,
      default: null,
    },
    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

// Auto-expire activity logs after 7 days
activitySchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 });
activitySchema.index({ entity: 1 });
activitySchema.index({ userId: 1 });
activitySchema.index({ action: 1 });

module.exports = mongoose.model("Activity", activitySchema);
