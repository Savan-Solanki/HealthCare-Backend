#!/usr/bin/env node
/**
 * backfill-storage.js — One-time script to populate storageFiles collection
 * from existing Prescriptions, Receipts, DischargeSummaries, and Lab Reports.
 *
 * Run on your server:
 *   cd /home/ubuntu/medikwik-Healthboddy-Backend
 *   node scripts/backfill-storage.js
 *
 * Safe to re-run: uses upsert on s3Key so no duplicates are created.
 */

"use strict";
require("dotenv").config();

const mongoose = require("mongoose");

// ─── DB Connect ───────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || process.env.DATABASE_URL || process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error("❌ No MongoDB URI found. Set MONGO_URI in your .env file.");
  process.exit(1);
}

// ─── Models ───────────────────────────────────────────────────────────────────
const Prescription    = require("../models/Prescription");
const Receipt         = require("../models/Receipt");
const DischargeSummary = require("../models/DischargeSummary");
const Report          = require("../models/Report");
const StorageFile     = require("../models/StorageFile");

// ─── Helpers ──────────────────────────────────────────────────────────────────
const S3_BUCKET = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET || "medikwik";

/**
 * Extract S3 key from a full S3 URL.
 * e.g. https://bucket.s3.ap-south-1.amazonaws.com/hospitals/xxx/file.pdf
 *   → hospitals/xxx/file.pdf
 */
function extractKeyFromUrl(url) {
  if (!url) return null;
  // Already a key (no http)
  if (!url.startsWith("http")) return url;
  try {
    const u = new URL(url);
    // pathname starts with /, strip it
    return u.pathname.replace(/^\//, "");
  } catch {
    return null;
  }
}

/**
 * Upsert a single record into storageFiles.
 * Returns "inserted" | "updated" | "skipped"
 */
async function upsert({ s3Key, bucket, hospitalId, module, mimeType, fileSizeBytes, uploadedAt }) {
  if (!s3Key) return "skipped";
  const result = await StorageFile.updateOne(
    { s3Key },
    {
      $setOnInsert: { s3Key },
      $set: {
        bucket,
        hospitalId: hospitalId || null,
        module,
        mimeType: mimeType || null,
        fileSizeBytes: fileSizeBytes || 0,
        uploadedAt: uploadedAt || new Date(),
      },
    },
    { upsert: true }
  );
  if (result.upsertedCount > 0) return "inserted";
  if (result.modifiedCount > 0) return "updated";
  return "skipped";
}

// ─── Counters ─────────────────────────────────────────────────────────────────
const stats = {
  prescriptions:     { inserted: 0, updated: 0, skipped: 0, errors: 0 },
  receipts:          { inserted: 0, updated: 0, skipped: 0, errors: 0 },
  dischargeSummaries:{ inserted: 0, updated: 0, skipped: 0, errors: 0 },
  labReports:        { inserted: 0, updated: 0, skipped: 0, errors: 0 },
};

function count(category, result) {
  if (result === "inserted") stats[category].inserted++;
  else if (result === "updated") stats[category].updated++;
  else if (result === "skipped") stats[category].skipped++;
}

// ─── Backfill: Prescriptions ──────────────────────────────────────────────────
async function backfillPrescriptions() {
  console.log("\n📄 Backfilling Prescriptions...");
  const cursor = Prescription.find({ "document.key": { $exists: true, $ne: "" } })
    .select("document hospitalId createdAt")
    .lean()
    .cursor();

  for await (const doc of cursor) {
    try {
      const key = doc.document?.key;
      const result = await upsert({
        s3Key:        key,
        bucket:       doc.document?.bucket || S3_BUCKET,
        hospitalId:   doc.hospitalId,
        module:       doc.document?.contentType === "application/pdf"
                        ? "Prescription PDF"
                        : "Prescription Image",
        mimeType:     doc.document?.contentType || "application/pdf",
        fileSizeBytes: doc.document?.size || 0,
        uploadedAt:   doc.document?.generatedAt || doc.createdAt,
      });
      count("prescriptions", result);
    } catch (err) {
      stats.prescriptions.errors++;
      console.error("  ⚠️  Prescription error:", err.message);
    }
  }

  // Also backfill patient-uploaded prescription images (originalUpload)
  const imageCursor = Prescription.find({
    source: "patient_uploaded",
    "originalUpload.size": { $gt: 0 },
  })
    .select("originalUpload hospitalId createdAt")
    .lean()
    .cursor();

  for await (const doc of imageCursor) {
    try {
      // Patient-uploaded prescriptions don't store s3Key directly —
      // skip if no document.key available (already handled above)
    } catch (err) {
      stats.prescriptions.errors++;
    }
  }

  console.log(`   ✅ inserted=${stats.prescriptions.inserted} updated=${stats.prescriptions.updated} skipped=${stats.prescriptions.skipped} errors=${stats.prescriptions.errors}`);
}

// ─── Backfill: Receipts ───────────────────────────────────────────────────────
async function backfillReceipts() {
  console.log("\n🧾 Backfilling Receipts...");
  const cursor = Receipt.find({ pdfUrl: { $exists: true, $ne: "" } })
    .select("pdfUrl hospitalId createdAt")
    .lean()
    .cursor();

  for await (const doc of cursor) {
    try {
      const s3Key = extractKeyFromUrl(doc.pdfUrl);
      const result = await upsert({
        s3Key,
        bucket:       S3_BUCKET,
        hospitalId:   doc.hospitalId,
        module:       "Receipt",
        mimeType:     "application/pdf",
        fileSizeBytes: 0, // size not stored on Receipt model
        uploadedAt:   doc.createdAt,
      });
      count("receipts", result);
    } catch (err) {
      stats.receipts.errors++;
      console.error("  ⚠️  Receipt error:", err.message);
    }
  }
  console.log(`   ✅ inserted=${stats.receipts.inserted} updated=${stats.receipts.updated} skipped=${stats.receipts.skipped} errors=${stats.receipts.errors}`);
}

// ─── Backfill: Discharge Summaries ───────────────────────────────────────────
async function backfillDischargeSummaries() {
  console.log("\n🏥 Backfilling Discharge Summaries...");
  const cursor = DischargeSummary.find({
    $or: [
      { s3Key: { $exists: true, $ne: null, $ne: "" } },
      { pdfUrl: { $exists: true, $ne: null, $ne: "" } },
    ],
    isDraft: false,
  })
    .select("s3Key pdfUrl hospitalId createdAt generatedAt")
    .lean()
    .cursor();

  for await (const doc of cursor) {
    try {
      const s3Key = doc.s3Key || extractKeyFromUrl(doc.pdfUrl);
      const result = await upsert({
        s3Key,
        bucket:       S3_BUCKET,
        hospitalId:   doc.hospitalId,
        module:       "Discharge Summary",
        mimeType:     "application/pdf",
        fileSizeBytes: 0, // size not stored on DischargeSummary
        uploadedAt:   doc.generatedAt || doc.createdAt,
      });
      count("dischargeSummaries", result);
    } catch (err) {
      stats.dischargeSummaries.errors++;
      console.error("  ⚠️  DischargeSummary error:", err.message);
    }
  }
  console.log(`   ✅ inserted=${stats.dischargeSummaries.inserted} updated=${stats.dischargeSummaries.updated} skipped=${stats.dischargeSummaries.skipped} errors=${stats.dischargeSummaries.errors}`);
}

// ─── Backfill: Lab Reports ────────────────────────────────────────────────────
async function backfillLabReports() {
  console.log("\n🔬 Backfilling Lab Reports...");
  const cursor = Report.find({ s3Key: { $exists: true, $ne: "" } })
    .select("s3Key fileSize contentType fileName uploadedAt createdAt")
    .lean()
    .cursor();

  for await (const doc of cursor) {
    try {
      const result = await upsert({
        s3Key:        doc.s3Key,
        bucket:       S3_BUCKET,
        hospitalId:   null, // Report model has no hospitalId — linked via patient
        module:       "Lab Report",
        mimeType:     doc.contentType || "application/pdf",
        fileSizeBytes: doc.fileSize || 0,
        uploadedAt:   doc.uploadedAt || doc.createdAt,
      });
      count("labReports", result);
    } catch (err) {
      stats.labReports.errors++;
      console.error("  ⚠️  Lab Report error:", err.message);
    }
  }
  console.log(`   ✅ inserted=${stats.labReports.inserted} updated=${stats.labReports.updated} skipped=${stats.labReports.skipped} errors=${stats.labReports.errors}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("==============================================");
  console.log("🚀 medikwik Storage Backfill Script");
  console.log("==============================================");
  console.log(`🔌 Connecting to MongoDB...`);

  await mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  console.log("✅ Connected to MongoDB");

  const startTime = Date.now();

  await backfillPrescriptions();
  await backfillReceipts();
  await backfillDischargeSummaries();
  await backfillLabReports();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("\n==============================================");
  console.log("📊 BACKFILL SUMMARY");
  console.log("==============================================");

  let totalInserted = 0, totalSkipped = 0, totalErrors = 0;
  for (const [category, s] of Object.entries(stats)) {
    console.log(`  ${category.padEnd(20)} inserted=${s.inserted}  updated=${s.updated}  skipped=${s.skipped}  errors=${s.errors}`);
    totalInserted += s.inserted;
    totalSkipped  += s.skipped;
    totalErrors   += s.errors;
  }

  console.log("----------------------------------------------");
  console.log(`  TOTAL                inserted=${totalInserted}  skipped=${totalSkipped}  errors=${totalErrors}`);
  console.log(`  Time elapsed: ${elapsed}s`);
  console.log("==============================================");

  if (totalErrors > 0) {
    console.warn(`\n⚠️  ${totalErrors} errors occurred. Check logs above.`);
  } else {
    console.log("\n✅ Backfill completed successfully!");
    console.log("   Refresh the Storage dashboard to see updated data.");
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  mongoose.disconnect().finally(() => process.exit(1));
});
