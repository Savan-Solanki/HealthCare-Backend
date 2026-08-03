const mongoose = require("mongoose");

const logSchema = new mongoose.Schema(
  {
    level: {
      type: String,
      enum: ["info", "warning", "error", "debug"],
      required: true,
      default: "info",
    },
    message: {
      type: String,
      required: [true, "Log message is required"],
      trim: true,
    },
    source: {
      type: String,
      trim: true,
      default: "system",
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    ip: {
      type: String,
      default: null,
    },
    method: {
      type: String,
      default: null,
    },
    path: {
      type: String,
      default: null,
    },
    statusCode: {
      type: Number,
      default: null,
    },
    responseTime: {
      type: Number, // ms
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

// Auto-expire logs after 90 days
logSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });
logSchema.index({ level: 1 });
logSchema.index({ source: 1 });
logSchema.index({ userId: 1 });

module.exports = mongoose.model("Log", logSchema);
