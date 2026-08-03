const mongoose = require("mongoose");

const platformAdSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      trim: true,
      default: "",
      maxlength: 120,
    },
    businessLink: {
      type: String,
      required: [true, "Business link is required"],
      trim: true,
      maxlength: 2048,
    },
    poster: {
      bucket: { type: String, default: null },
      key: { type: String, default: null },
      contentType: { type: String, default: null },
      size: { type: Number, default: null },
      uploadedAt: { type: Date, default: null },
    },
    durationDays: {
      type: Number,
      required: true,
      min: [1, "Ad duration must be at least 1 day"],
      max: [365, "Ad duration cannot exceed 365 days"],
    },
    startsAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    targetAudience: {
      type: String,
      enum: ["all", "patient", "staff"],
      default: "all",
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

platformAdSchema.index({ isActive: 1, expiresAt: 1, targetAudience: 1 });

module.exports = mongoose.model("PlatformAd", platformAdSchema);
