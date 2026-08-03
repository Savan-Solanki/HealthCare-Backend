const mongoose = require("mongoose");

const reportSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PatientUser",
      required: [true, "User ID is required"],
      index: true,
    },
    fileName: {
      type: String,
      required: [true, "File name is required"],
      trim: true,
    },
    fileSize: {
      type: Number,
      required: [true, "File size is required"],
      min: [0, "File size cannot be negative"],
    },
    contentType: {
      type: String,
      required: [true, "Content type is required"],
      trim: true,
    },
    s3Key: {
      type: String,
      required: [true, "S3 key is required"],
      trim: true,
    },
    fileUrl: {
      type: String,
      trim: true,
    },
    uploadedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
reportSchema.index({ userId: 1, uploadedAt: -1 });

module.exports = mongoose.model("Report", reportSchema);
