"use strict";
const mongoose = require("mongoose");

/**
 * StorageFile — tracks every file successfully uploaded to S3.
 * One document per S3 object key (upserted, so re-uploads just update the record).
 */
const storageFileSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      default: null,
      index: true,
    },
    bucket: {
      type: String,
      required: true,
      trim: true,
    },
    s3Key: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    originalName: {
      type: String,
      default: null,
      trim: true,
    },
    fileName: {
      type: String,
      default: null,
      trim: true,
    },
    module: {
      type: String,
      required: true,
      enum: [
        "Prescription PDF",
        "Prescription Image",
        "Lab Report",
        "Discharge Summary",
        "Receipt",
        "Admission File",
        "Hospital Logo",
        "Doctor Signature",
        "Patient Profile",
        "Staff Profile",
        "Other",
      ],
      index: true,
    },
    mimeType: {
      type: String,
      default: null,
      trim: true,
    },
    fileSizeBytes: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    uploadedByModel: {
      type: String,
      enum: ["User", "PatientUser", null],
      default: null,
    },
    uploadedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: false,
    collection: "storageFiles",
  }
);

// ─── Compound indexes for dashboard queries ───────────────────────────────────
storageFileSchema.index({ hospitalId: 1, uploadedAt: -1 });
storageFileSchema.index({ hospitalId: 1, module: 1 });
storageFileSchema.index({ uploadedAt: -1 });
storageFileSchema.index({ fileSizeBytes: -1 });

module.exports = mongoose.model("StorageFile", storageFileSchema);
