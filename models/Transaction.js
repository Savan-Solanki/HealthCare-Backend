const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PatientUser",
      required: [true, "User ID is required"],
      index: true,
    },
    planType: {
      type: String,
      enum: ["prescription", "report"],
      required: [true, "Plan type is required"],
    },
    planName: {
      type: String,
      required: [true, "Plan name is required"],
    },
    amount: {
      type: Number,
      required: [true, "Amount is required"],
      min: [0, "Amount cannot be negative"],
    },
    paymentId: {
      type: String,
      default: "",
    },
    orderId: {
      type: String,
      required: [true, "Order ID is required"],
      unique: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "completed", "failed"],
      default: "pending",
      index: true,
    },
    purchasedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
transactionSchema.index({ userId: 1, purchasedAt: -1 });

module.exports = mongoose.model("Transaction", transactionSchema);
