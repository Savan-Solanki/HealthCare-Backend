const mongoose = require("mongoose");

const creditTransactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PatientUser",
      required: [true, "User ID is required"],
      index: true,
    },
    creditType: {
      type: String,
      enum: ["report", "prescription"],
      required: [true, "Credit type is required"],
    },
    type: {
      type: String,
      enum: ["addition", "consumption"],
      required: [true, "Transaction type is required"],
    },
    amount: {
      type: Number,
      required: [true, "Amount is required"],
      min: [1, "Amount must be at least 1"],
    },
    reason: {
      type: String,
      required: [true, "Reason is required"],
    },
    performedBy: {
      type: String,
      enum: ["system", "admin"],
      required: true,
      default: "system",
    },
    adminUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

creditTransactionSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("CreditTransaction", creditTransactionSchema);
