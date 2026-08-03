const mongoose = require("mongoose");

const admissionTreatmentSchema = new mongoose.Schema(
  {
    admissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admission",
      required: [true, "Admission reference is required"],
      index: true,
    },
    patientRecordId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Patient",
      required: [true, "Patient reference is required"],
      index: true,
    },
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: [true, "Hospital reference is required"],
      index: true,
    },
    dateAndTime: {
      type: Date,
      required: [true, "Date and time are required"],
      default: Date.now,
    },
    category: {
      type: String,
      required: [true, "Treatment category is required"],
      enum: [
        "Medicines",
        "Injections",
        "IV Fluids",
        "Lab Tests",
        "X-Ray",
        "CT Scan",
        "MRI",
        "ECG",
        "Oxygen",
        "Nebulization",
        "Physiotherapy",
        "Surgery/Operation",
        "ICU Charges",
        "Room Charges",
        "Nursing Charges",
        "Medical Equipment Usage",
        "Hospital Consumables",
        "Doctor Visit Charges",
        "Custom Treatment/Procedure",
      ],
      index: true,
    },
    treatmentName: {
      type: String,
      required: [true, "Treatment/procedure name is required"],
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    quantity: {
      type: Number,
      required: [true, "Quantity is required"],
      min: [1, "Quantity must be at least 1"],
      default: 1,
    },
    unit: {
      type: String,
      required: [true, "Unit is required"],
      trim: true,
      default: "Qty",
    },
    unitPrice: {
      type: Number,
      required: [true, "Unit price is required"],
      min: [0, "Unit price cannot be negative"],
      default: 0,
    },
    totalAmount: {
      type: Number,
      required: true,
      default: 0,
    },
    notes: {
      type: String,
      trim: true,
      default: "",
    },
    addedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Added by reference is required"],
    },
    addedByName: {
      type: String,
      required: [true, "Added by name is required"],
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    auditLogs: [
      {
        action: { type: String, required: true }, // CREATED, UPDATED, DELETED
        details: { type: String, default: "" },
        date: { type: Date, default: Date.now },
        performedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        performedByName: { type: String, default: "System" },
      },
    ],
  },
  {
    timestamps: true,
  }
);

// Pre-save hook to calculate totalAmount
admissionTreatmentSchema.pre("save", function (next) {
  this.totalAmount = (this.quantity || 0) * (this.unitPrice || 0);
  next();
});

admissionTreatmentSchema.index({ admissionId: 1, isDeleted: 1, dateAndTime: -1 });

module.exports = mongoose.model("AdmissionTreatment", admissionTreatmentSchema);
