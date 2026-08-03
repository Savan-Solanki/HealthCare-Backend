const mongoose = require("mongoose");

const receiptSchema = new mongoose.Schema(
  {
    receiptNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: [true, "Hospital is required"],
      index: true,
    },
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Patient",
      required: [true, "Patient is required"],
      index: true,
    },
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Doctor",
      required: [true, "Doctor is required"],
      index: true,
    },
    consultationType: {
      type: String,
      trim: true,
      default: "",
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    lineItems: {
      type: [
        {
          description: { type: String, trim: true, default: "" },
          amount: { type: Number, min: 0, default: 0 },
          _id: false,
        },
      ],
      default: [],
    },
    subtotal: {
      type: Number,
      required: true,
      min: [0, "Subtotal cannot be negative"],
    },
    discount: {
      type: Number,
      default: 0,
      min: [0, "Discount cannot be negative"],
    },
    tax: {
      type: Number,
      default: 0,
      min: [0, "Tax cannot be negative"],
    },
    amount: {
      type: Number,
      required: true,
      min: [0, "Amount cannot be negative"],
    },
    paidAmount: {
      type: Number,
      required: true,
      min: [0, "Paid amount cannot be negative"],
    },
    dueAmount: {
      type: Number,
      required: true,
      min: [0, "Due amount cannot be negative"],
    },
    pdfUrl: {
      type: String,
      required: true,
    },
    admissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admission",
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for common queries
receiptSchema.index({ hospitalId: 1, createdAt: -1 });
receiptSchema.index({ patientId: 1, createdAt: -1 });
receiptSchema.index({ doctorId: 1, createdAt: -1 });
receiptSchema.index({ admissionId: 1 });

module.exports = mongoose.model("Receipt", receiptSchema);
