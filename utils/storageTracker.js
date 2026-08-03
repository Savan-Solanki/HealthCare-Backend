"use strict";
/**
 * storageTracker.js
 *
 * Centralised storage tracking service.
 * Called AFTER every successful S3 upload/delete — never throws, never blocks.
 *
 * Every public function is fire-and-forget safe:
 *   void trackUpload({ ... });
 *   void trackDelete(s3Key);
 */

const StorageFile = require("../models/StorageFile");
const logger = require("./logger");

// ─── Module name constants ─────────────────────────────────────────────────────
const STORAGE_MODULES = Object.freeze({
  PRESCRIPTION_PDF:   "Prescription PDF",
  PRESCRIPTION_IMAGE: "Prescription Image",
  LAB_REPORT:         "Lab Report",
  DISCHARGE_SUMMARY:  "Discharge Summary",
  RECEIPT:            "Receipt",
  ADMISSION_FILE:     "Admission File",
  HOSPITAL_LOGO:      "Hospital Logo",
  DOCTOR_SIGNATURE:   "Doctor Signature",
  PATIENT_PROFILE:    "Patient Profile",
  STAFF_PROFILE:      "Staff Profile",
  OTHER:              "Other",
});

/**
 * Infer module from S3 key prefix when not explicitly provided.
 * @param {string} s3Key
 * @returns {string}
 */
const inferModuleFromKey = (s3Key) => {
  const k = String(s3Key || "").toLowerCase();
  if (k.startsWith("prescriptions/"))          return STORAGE_MODULES.PRESCRIPTION_PDF;
  if (k.startsWith("discharge-summaries/"))    return STORAGE_MODULES.DISCHARGE_SUMMARY;
  if (k.startsWith("receipts/"))               return STORAGE_MODULES.RECEIPT;
  if (k.startsWith("reports/"))                return STORAGE_MODULES.LAB_REPORT;
  if (k.includes("/logo/"))                    return STORAGE_MODULES.HOSPITAL_LOGO;
  if (k.includes("/avatars/patients/"))        return STORAGE_MODULES.PATIENT_PROFILE;
  if (k.includes("/avatars/staff/"))           return STORAGE_MODULES.STAFF_PROFILE;
  if (k.includes("/doctor-signature/"))        return STORAGE_MODULES.DOCTOR_SIGNATURE;
  if (k.startsWith("hospital-assets/"))        return STORAGE_MODULES.HOSPITAL_LOGO;
  if (k.startsWith("media/ads/"))              return STORAGE_MODULES.OTHER;
  return STORAGE_MODULES.OTHER;
};

/**
 * Normalise hospitalId to a plain string or null.
 */
const normaliseHospitalId = (value) => {
  if (!value) return null;
  if (typeof value === "object" && value._id) return value._id;
  return value;
};

/**
 * Track a successful S3 upload.
 * Uses upsert on s3Key — safe to call multiple times for the same key.
 *
 * @param {object} params
 * @param {*}      [params.hospitalId]
 * @param {string} params.bucket
 * @param {string} params.s3Key
 * @param {string} [params.originalName]
 * @param {string} [params.fileName]
 * @param {string} params.module  — use STORAGE_MODULES constants
 * @param {string} [params.mimeType]
 * @param {number} params.fileSizeBytes
 * @param {*}      [params.uploadedBy]
 * @param {string} [params.uploadedByModel]  "User" | "PatientUser"
 * @returns {Promise<void>}
 */
const trackUpload = async ({
  hospitalId,
  bucket,
  s3Key,
  originalName,
  fileName,
  module,
  mimeType,
  fileSizeBytes,
  uploadedBy,
  uploadedByModel,
}) => {
  try {
    if (!s3Key) return;
    const resolvedModule = module || inferModuleFromKey(s3Key);

    await StorageFile.findOneAndUpdate(
      { s3Key },
      {
        $set: {
          hospitalId: normaliseHospitalId(hospitalId),
          bucket: String(bucket || ""),
          s3Key,
          originalName: originalName || null,
          fileName: fileName || null,
          module: resolvedModule,
          mimeType: mimeType || null,
          fileSizeBytes: Number(fileSizeBytes) || 0,
          uploadedBy: uploadedBy || null,
          uploadedByModel: uploadedByModel || null,
          uploadedAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    // Never propagate — storage tracking is non-critical
    logger.warn(`[storageTracker] trackUpload failed for key=${s3Key}: ${err.message}`);
  }
};

/**
 * Remove the tracking record for a deleted S3 object.
 *
 * @param {string} s3Key
 * @returns {Promise<void>}
 */
const trackDelete = async (s3Key) => {
  try {
    if (!s3Key) return;
    await StorageFile.deleteOne({ s3Key });
  } catch (err) {
    logger.warn(`[storageTracker] trackDelete failed for key=${s3Key}: ${err.message}`);
  }
};

/**
 * Replace an existing tracking record (old key deleted, new key created).
 *
 * @param {object} params
 * @param {string} params.oldKey  — S3 key being replaced
 * @param {*}      params.*       — same fields as trackUpload
 * @returns {Promise<void>}
 */
const trackReplace = async ({ oldKey, ...newRecord }) => {
  await Promise.all([
    trackDelete(oldKey),
    trackUpload(newRecord),
  ]);
};

module.exports = {
  STORAGE_MODULES,
  inferModuleFromKey,
  trackUpload,
  trackDelete,
  trackReplace,
};
