const mongoose = require("mongoose");

const hospitalAuditLogSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
      index: true,
    },
    action: {
      type: String,
      required: true,
      index: true,
    },
    performedBy: {
      type: String,
      required: true,
      index: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Auto-expire audit logs after 7 days
hospitalAuditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

module.exports = mongoose.model("HospitalAuditLog", hospitalAuditLogSchema);
