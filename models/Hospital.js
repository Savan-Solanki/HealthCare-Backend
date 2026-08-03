const mongoose = require("mongoose");
const crypto = require("crypto");

const hospitalSchema = new mongoose.Schema(
  {
    hospitalCode: {
      type: String,
      unique: true,
      immutable: true,
      index: true,
    },
    name: {
      type: String,
      required: [true, "Hospital name is required"],
      trim: true,
      minlength: [3, "Name must be at least 3 characters"],
      maxlength: [200, "Name cannot exceed 200 characters"],
    },
    city: {
      type: String,
      required: [true, "City is required"],
      trim: true,
    },
    state: {
      type: String,
      trim: true,
      default: null,
    },
    address: {
      type: String,
      trim: true,
      default: null,
    },
    phone: {
      type: String,
      default: null,
    },
    email: {
      type: String,
      lowercase: true,
      trim: true,
      default: null,
    },
    beds: {
      type: Number,
      required: [true, "Number of beds is required"],
      min: [0, "Beds cannot be negative"],
    },
    doctors: {
      type: Number,
      default: 0,
      min: [0, "Doctors count cannot be negative"],
    },
    maxDoctors: {
      type: Number,
      default: null,
      min: [1, "Max doctors must be at least 1"],
    },
    maxReceptionists: {
      type: Number,
      default: null,
      min: [1, "Max receptionists must be at least 1"],
    },
    maxNurses: {
      type: Number,
      default: null,
      min: [1, "Max nurses must be at least 1"],
    },
    maxStaff: {
      type: Number,
      default: null,
      min: [1, "Max staff must be at least 1"],
    },
    status: {
      type: String,
      enum: ["Active", "Inactive", "Under Maintenance", "Pending"],
      default: "Active",
    },
    accessType: {
      type: String,
      enum: ["permanent", "demo"],
      default: "permanent",
      index: true,
    },
    subscriptionType: {
      type: String,
      enum: ["permanent", "demo"],
      default: "permanent",
      index: true,
    },
    demoDurationDays: {
      type: Number,
      default: null,
      min: [1, "Demo duration must be at least 1 day"],
    },
    demoStartedAt: {
      type: Date,
      default: null,
    },
    demoStartDate: {
      type: Date,
      default: null,
    },
    demoExpiresAt: {
      type: Date,
      default: null,
      index: true,
    },
    demoExpiryDate: {
      type: Date,
      default: null,
      index: true,
    },
    subscriptionStatus: {
      type: String,
      enum: ["active", "expired"],
      default: "active",
      index: true,
    },
    isArchived: {
      type: Boolean,
      default: false,
      index: true,
    },
    archivedAt: {
      type: Date,
      default: null,
    },
    archivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    archiveReason: {
      type: String,
      default: null,
    },
    expiryEmail7DaysSent: {
      type: Boolean,
      default: false,
    },
    expiryEmail3DaysSent: {
      type: Boolean,
      default: false,
    },
    expiryEmail1DaySent: {
      type: Boolean,
      default: false,
    },
    expiryEmail0DaySent: {
      type: Boolean,
      default: false,
    },
    demoWarningEmailSentAt: {
      type: Date,
      default: null,
    },
    demoExpiredNotifiedAt: {
      type: Date,
      default: null,
    },
    type: {
      type: String,
      enum: ["Government", "Private", "Trust", "Clinic", "Multi-speciality"],
      default: "Private",
    },
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    registrationNumber: {
      type: String,
      default: null,
    },
    establishedYear: {
      type: Number,
      default: null,
    },
    specializations: {
      type: [String],
      default: [],
    },
    logo: {
      bucket: { type: String, default: null },
      key: { type: String, default: null },
      contentType: { type: String, default: null },
      size: { type: Number, default: null },
      uploadedAt: { type: Date, default: null },
    },
    logoUrl: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────
hospitalSchema.index({ city: 1 });
hospitalSchema.index({ status: 1 });
hospitalSchema.index({ name: "text" });

hospitalSchema.pre("validate", function (next) {
  if (!this.hospitalCode) {
    this.hospitalCode = `HSP-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  }
  next();
});

module.exports = mongoose.model("Hospital", hospitalSchema);
