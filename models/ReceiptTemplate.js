const mongoose = require("mongoose");

const receiptTemplateSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: [true, "Hospital is required"],
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Creator is required"],
      index: true,
    },
    templateName: {
      type: String,
      required: [true, "Template name is required"],
      trim: true,
      maxlength: [120, "Template name cannot exceed 120 characters"],
    },
    consultationType: {
      type: String,
      trim: true,
      default: "",
    },
    amount: {
      type: Number,
      required: [true, "Amount is required"],
      min: [0, "Amount cannot be negative"],
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    useCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastUsedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Hospital-scoped (shared across all staff in same hospital)
receiptTemplateSchema.index({ hospitalId: 1, createdAt: -1 });
receiptTemplateSchema.index({ hospitalId: 1, useCount: -1 });
receiptTemplateSchema.index({ templateName: "text", consultationType: "text" });

module.exports = mongoose.model("ReceiptTemplate", receiptTemplateSchema);
