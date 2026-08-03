"use strict";
/**
 * storageController.js
 * Super-Admin-only analytics endpoints for the Manage Storage module.
 * All reads use MongoDB aggregation — zero AWS S3 API calls.
 */

const mongoose = require("mongoose");
const StorageFile = require("../models/StorageFile");
const Hospital = require("../models/Hospital");
const Prescription = require("../models/Prescription");
const catchAsync = require("../utils/catchAsync");
const AppError = require("../utils/AppError");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format bytes into a human-readable string. */
const formatBytes = (bytes) => {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
};

/** Parse pagination params. */
const parsePagination = (query) => {
  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 25));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
};

/** Resolve hospital match stage for search terms. */
const buildHospitalMatch = async (search) => {
  if (!search) return null;
  const regex = { $regex: String(search).trim(), $options: "i" };
  const hospitals = await Hospital.find({
    $or: [{ name: regex }, { hospitalCode: regex }, { email: regex }],
    isArchived: { $ne: true },
  })
    .select("_id")
    .lean();
  return hospitals.map((h) => h._id);
};

/** Today UTC start */
const todayStart = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

/** Start of current month */
const monthStart = () => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

// ─── GET /admin/storage/dashboard ─────────────────────────────────────────────
exports.getDashboard = catchAsync(async (req, res) => {
  const [globalStats, todayStats, monthStats, topHospitals, moduleStats, trendRaw] = await Promise.all([
    // Overall totals
    StorageFile.aggregate([
      {
        $group: {
          _id: "$hospitalId",
          totalFiles: { $sum: 1 },
          totalBytes: { $sum: "$fileSizeBytes" },
          lastUpload: { $max: "$uploadedAt" },
        },
      },
      {
        $group: {
          _id: null,
          totalHospitals: { $sum: 1 },
          totalFiles: { $sum: "$totalFiles" },
          totalBytes: { $sum: "$totalBytes" },
          maxBytes: { $max: "$totalBytes" },
          minBytes: { $min: "$totalBytes" },
          avgBytes: { $avg: "$totalBytes" },
          maxHospitalId: { $first: "$_id" }, // placeholder; replaced below
          minHospitalId: { $last: "$_id" },
        },
      },
    ]),

    // Today uploads
    StorageFile.countDocuments({ uploadedAt: { $gte: todayStart() } }),

    // This month uploads
    StorageFile.countDocuments({ uploadedAt: { $gte: monthStart() } }),

    // Top 10 hospitals by storage
    StorageFile.aggregate([
      {
        $group: {
          _id: "$hospitalId",
          totalBytes: { $sum: "$fileSizeBytes" },
          totalFiles: { $sum: 1 },
          lastUpload: { $max: "$uploadedAt" },
        },
      },
      { $sort: { totalBytes: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: "hospitals",
          localField: "_id",
          foreignField: "_id",
          as: "hospital",
        },
      },
      { $unwind: { path: "$hospital", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          hospitalId: "$_id",
          hospitalName: { $ifNull: ["$hospital.name", "Unknown"] },
          hospitalCode: { $ifNull: ["$hospital.hospitalCode", "—"] },
          totalBytes: 1,
          totalFiles: 1,
          lastUpload: 1,
        },
      },
    ]),

    // Module distribution
    StorageFile.aggregate([
      {
        $group: {
          _id: "$module",
          totalFiles: { $sum: 1 },
          totalBytes: { $sum: "$fileSizeBytes" },
        },
      },
      { $sort: { totalBytes: -1 } },
    ]),

    // 12-month upload trend
    StorageFile.aggregate([
      {
        $match: {
          uploadedAt: {
            $gte: new Date(new Date().setMonth(new Date().getMonth() - 11, 1)),
          },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: "$uploadedAt" },
            month: { $month: "$uploadedAt" },
          },
          count: { $sum: 1 },
          bytes: { $sum: "$fileSizeBytes" },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]),
  ]);

  const global = globalStats[0] || {
    totalHospitals: 0,
    totalFiles: 0,
    totalBytes: 0,
    maxBytes: 0,
    minBytes: 0,
    avgBytes: 0,
  };

  // Resolve largest/smallest hospital names
  let largestHospital = null;
  let smallestHospital = null;
  if (topHospitals.length > 0) {
    largestHospital = topHospitals[0];
  }
  // Smallest: re-query
  const bottomHospital = await StorageFile.aggregate([
    { $group: { _id: "$hospitalId", totalBytes: { $sum: "$fileSizeBytes" } } },
    { $sort: { totalBytes: 1 } },
    { $limit: 1 },
    { $lookup: { from: "hospitals", localField: "_id", foreignField: "_id", as: "h" } },
    { $unwind: { path: "$h", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        hospitalName: { $ifNull: ["$h.name", "Unknown"] },
        hospitalCode: { $ifNull: ["$h.hospitalCode", "—"] },
        totalBytes: 1,
      },
    },
  ]);
  if (bottomHospital.length > 0) smallestHospital = bottomHospital[0];

  // Total hospitals from Hospital collection (including those with no files)
  const totalHospitals = await Hospital.countDocuments({ isArchived: { $ne: true } });

  res.status(200).json({
    success: true,
    data: {
      summary: {
        totalHospitals,
        trackedHospitals: global.totalHospitals || 0,
        totalFiles: global.totalFiles || 0,
        totalBytes: global.totalBytes || 0,
        totalBytesFormatted: formatBytes(global.totalBytes || 0),
        avgBytesPerHospital: Math.round(global.avgBytes || 0),
        avgBytesPerHospitalFormatted: formatBytes(Math.round(global.avgBytes || 0)),
        todayUploads: todayStats,
        monthlyUploads: monthStats,
        largestHospital,
        smallestHospital,
      },
      topHospitals,
      moduleDistribution: moduleStats.map((m) => ({
        module: m._id,
        totalFiles: m.totalFiles,
        totalBytes: m.totalBytes,
        totalBytesFormatted: formatBytes(m.totalBytes),
      })),
      monthlyTrend: trendRaw.map((t) => ({
        year: t._id.year,
        month: t._id.month,
        count: t.count,
        bytes: t.bytes,
        bytesFormatted: formatBytes(t.bytes),
        label: `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][t._id.month - 1]} ${t._id.year}`,
      })),
    },
  });
});

// ─── GET /admin/storage/hospitals ─────────────────────────────────────────────
exports.getHospitalStorage = catchAsync(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const { search, filter, sort } = req.query;

  // Resolve hospital IDs from search
  let hospitalIds = null;
  if (search) {
    hospitalIds = await buildHospitalMatch(search);
    if (hospitalIds.length === 0) {
      return res.status(200).json({ success: true, data: { hospitals: [], total: 0, page, limit } });
    }
  }

  // Build storage aggregation
  const matchStage = {};
  if (hospitalIds) matchStage.hospitalId = { $in: hospitalIds };

  const storageAgg = await StorageFile.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: "$hospitalId",
        totalFiles: { $sum: 1 },
        totalBytes: { $sum: "$fileSizeBytes" },
        lastUpload: { $max: "$uploadedAt" },
      },
    },
    {
      $lookup: {
        from: "hospitals",
        localField: "_id",
        foreignField: "_id",
        as: "hospital",
      },
    },
    { $unwind: { path: "$hospital", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        hospitalId: "$_id",
        hospitalName: { $ifNull: ["$hospital.name", "Unknown"] },
        hospitalCode: { $ifNull: ["$hospital.hospitalCode", "—"] },
        hospitalCity: { $ifNull: ["$hospital.city", ""] },
        hospitalStatus: { $ifNull: ["$hospital.status", "Unknown"] },
        hospitalEmail: { $ifNull: ["$hospital.email", ""] },
        totalFiles: 1,
        totalBytes: 1,
        lastUpload: 1,
      },
    },
  ]);

  // Apply size filter
  let filtered = storageAgg;
  if (filter === "gt500mb") filtered = filtered.filter((h) => h.totalBytes > 500 * 1024 * 1024);
  else if (filter === "gt1gb")  filtered = filtered.filter((h) => h.totalBytes > 1024 * 1024 * 1024);
  else if (filter === "gt5gb")  filtered = filtered.filter((h) => h.totalBytes > 5 * 1024 * 1024 * 1024);
  else if (filter === "gt10gb") filtered = filtered.filter((h) => h.totalBytes > 10 * 1024 * 1024 * 1024);
  else if (filter === "active") filtered = filtered.filter((h) => h.hospitalStatus === "Active");
  else if (filter === "inactive") filtered = filtered.filter((h) => h.hospitalStatus !== "Active");

  // Apply sort
  const sortFns = {
    highestStorage: (a, b) => b.totalBytes - a.totalBytes,
    lowestStorage:  (a, b) => a.totalBytes - b.totalBytes,
    mostFiles:      (a, b) => b.totalFiles - a.totalFiles,
    leastFiles:     (a, b) => a.totalFiles - b.totalFiles,
    newestUpload:   (a, b) => new Date(b.lastUpload) - new Date(a.lastUpload),
    oldestUpload:   (a, b) => new Date(a.lastUpload) - new Date(b.lastUpload),
  };
  filtered.sort(sortFns[sort] || sortFns.highestStorage);

  const total = filtered.length;
  const paginated = filtered.slice(skip, skip + limit).map((h) => ({
    ...h,
    totalBytesFormatted: formatBytes(h.totalBytes),
  }));

  res.status(200).json({
    success: true,
    data: { hospitals: paginated, total, page, limit, totalPages: Math.ceil(total / limit) },
  });
});

// ─── GET /admin/storage/hospitals/:id ─────────────────────────────────────────
exports.getHospitalDetail = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return next(new AppError("Invalid hospital ID.", 400));
  }

  const hospitalId = new mongoose.Types.ObjectId(id);

  const [hospital, storageStats, todayCount, moduleBreakdown, largestFiles, recentUploads, monthlyTrend] =
    await Promise.all([
      Hospital.findById(hospitalId).select("name hospitalCode city state email status").lean(),

      StorageFile.aggregate([
        { $match: { hospitalId } },
        {
          $group: {
            _id: null,
            totalFiles: { $sum: 1 },
            totalBytes: { $sum: "$fileSizeBytes" },
            lastUpload: { $max: "$uploadedAt" },
            avgFileSize: { $avg: "$fileSizeBytes" },
          },
        },
      ]),

      StorageFile.countDocuments({ hospitalId, uploadedAt: { $gte: todayStart() } }),

      StorageFile.aggregate([
        { $match: { hospitalId } },
        {
          $group: {
            _id: "$module",
            totalFiles: { $sum: 1 },
            totalBytes: { $sum: "$fileSizeBytes" },
            avgFileSize: { $avg: "$fileSizeBytes" },
            lastUpload: { $max: "$uploadedAt" },
          },
        },
        { $sort: { totalBytes: -1 } },
      ]),

      StorageFile.find({ hospitalId })
        .sort({ fileSizeBytes: -1 })
        .limit(10)
        .select("fileName originalName module mimeType fileSizeBytes uploadedAt s3Key")
        .lean(),

      StorageFile.find({ hospitalId })
        .sort({ uploadedAt: -1 })
        .limit(20)
        .select("fileName originalName module mimeType fileSizeBytes uploadedAt")
        .lean(),

      StorageFile.aggregate([
        {
          $match: {
            hospitalId,
            uploadedAt: {
              $gte: new Date(new Date().setMonth(new Date().getMonth() - 11, 1)),
            },
          },
        },
        {
          $group: {
            _id: {
              year: { $year: "$uploadedAt" },
              month: { $month: "$uploadedAt" },
            },
            count: { $sum: 1 },
            bytes: { $sum: "$fileSizeBytes" },
          },
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } },
      ]),
    ]);

  if (!hospital) return next(new AppError("Hospital not found.", 404));

  const stats = storageStats[0] || { totalFiles: 0, totalBytes: 0, lastUpload: null, avgFileSize: 0 };

  res.status(200).json({
    success: true,
    data: {
      hospital,
      storage: {
        totalFiles: stats.totalFiles,
        totalBytes: stats.totalBytes,
        totalBytesFormatted: formatBytes(stats.totalBytes),
        avgFileSize: Math.round(stats.avgFileSize || 0),
        avgFileSizeFormatted: formatBytes(Math.round(stats.avgFileSize || 0)),
        lastUpload: stats.lastUpload,
        todayUploads: todayCount,
      },
      moduleBreakdown: moduleBreakdown.map((m) => ({
        module: m._id,
        totalFiles: m.totalFiles,
        totalBytes: m.totalBytes,
        totalBytesFormatted: formatBytes(m.totalBytes),
        avgFileSize: Math.round(m.avgFileSize || 0),
        avgFileSizeFormatted: formatBytes(Math.round(m.avgFileSize || 0)),
        lastUpload: m.lastUpload,
      })),
      largestFiles: largestFiles.map((f) => ({
        ...f,
        fileSizeBytesFormatted: formatBytes(f.fileSizeBytes),
      })),
      recentUploads: recentUploads.map((f) => ({
        ...f,
        fileSizeBytesFormatted: formatBytes(f.fileSizeBytes),
      })),
      monthlyTrend: monthlyTrend.map((t) => ({
        year: t._id.year,
        month: t._id.month,
        count: t.count,
        bytes: t.bytes,
        bytesFormatted: formatBytes(t.bytes),
        label: `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][t._id.month - 1]} ${t._id.year}`,
      })),
    },
  });
});

// ─── GET /admin/storage/trend ──────────────────────────────────────────────────
exports.getGlobalTrend = catchAsync(async (req, res) => {
  const months = Math.min(24, Math.max(1, parseInt(req.query.months) || 12));
  const since = new Date();
  since.setMonth(since.getMonth() - (months - 1), 1);
  since.setUTCHours(0, 0, 0, 0);

  const trend = await StorageFile.aggregate([
    { $match: { uploadedAt: { $gte: since } } },
    {
      $group: {
        _id: { year: { $year: "$uploadedAt" }, month: { $month: "$uploadedAt" } },
        count: { $sum: 1 },
        bytes: { $sum: "$fileSizeBytes" },
      },
    },
    { $sort: { "_id.year": 1, "_id.month": 1 } },
  ]);

  res.status(200).json({
    success: true,
    data: trend.map((t) => ({
      year: t._id.year,
      month: t._id.month,
      count: t.count,
      bytes: t.bytes,
      bytesFormatted: formatBytes(t.bytes),
      label: `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][t._id.month - 1]} ${t._id.year}`,
    })),
  });
});

// ─── GET /admin/storage/export ─────────────────────────────────────────────────
exports.exportStorage = catchAsync(async (req, res) => {
  const { format = "csv", hospitalId } = req.query;

  const matchFilter = {};
  if (hospitalId && mongoose.Types.ObjectId.isValid(hospitalId)) {
    matchFilter.hospitalId = new mongoose.Types.ObjectId(hospitalId);
  }

  const files = await StorageFile.find(matchFilter)
    .sort({ uploadedAt: -1 })
    .select("hospitalId s3Key fileName module mimeType fileSizeBytes uploadedAt")
    .lean();

  // Enrich with hospital names
  const hospitalIds = [...new Set(files.map((f) => String(f.hospitalId)).filter(Boolean))];
  const hospitals = await Hospital.find({
    _id: { $in: hospitalIds },
  })
    .select("name hospitalCode")
    .lean();
  const hospitalMap = Object.fromEntries(hospitals.map((h) => [String(h._id), h]));

  const rows = files.map((f) => {
    const h = hospitalMap[String(f.hospitalId)] || {};
    return {
      hospitalName: h.name || "Unknown",
      hospitalCode: h.hospitalCode || "—",
      fileName: f.fileName || "",
      module: f.module || "",
      mimeType: f.mimeType || "",
      fileSizeBytes: f.fileSizeBytes,
      fileSizeFormatted: formatBytes(f.fileSizeBytes),
      s3Key: f.s3Key,
      uploadedAt: f.uploadedAt ? new Date(f.uploadedAt).toISOString() : "",
    };
  });

  if (format === "json") {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", "attachment; filename=\"storage-export.json\"");
    return res.status(200).json({ success: true, total: rows.length, data: rows });
  }

  // Default: CSV
  const headers = ["hospitalName","hospitalCode","fileName","module","mimeType","fileSizeBytes","fileSizeFormatted","s3Key","uploadedAt"];
  const csvLines = [
    headers.join(","),
    ...rows.map((r) =>
      headers.map((h) => `"${String(r[h] || "").replace(/"/g, '""')}"`).join(",")
    ),
  ];

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=\"storage-export.csv\"");
  res.status(200).send(csvLines.join("\n"));
});

// ─── GET /admin/storage/prescriptions ─────────────────────────────────────────
/**
 * Returns prescription counts grouped by hospital for the Super Admin.
 * Supports: ?search=, ?filter=doctor_generated|patient_uploaded|today|this_month,
 *           ?sort=mostPrescriptions|leastPrescriptions|newest|oldest|alphabetical,
 *           ?page=, ?limit=
 */
exports.getPrescriptionsByHospital = catchAsync(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const { search, filter, sort } = req.query;

  // Resolve hospital IDs from search
  let hospitalIds = null;
  if (search) {
    hospitalIds = await buildHospitalMatch(search);
    if (hospitalIds.length === 0) {
      return res.status(200).json({
        success: true,
        data: { hospitals: [], total: 0, page, limit, totalPages: 0, grandTotal: 0 },
      });
    }
  }

  // Build match stage for Prescription collection
  const matchStage = { hospitalId: { $exists: true, $ne: null } };
  if (hospitalIds) matchStage.hospitalId = { $in: hospitalIds };

  // Time-based filters
  if (filter === "today") {
    matchStage.createdAt = { $gte: todayStart() };
  } else if (filter === "this_month") {
    matchStage.createdAt = { $gte: monthStart() };
  } else if (filter === "doctor_generated" || filter === "patient_uploaded") {
    matchStage.source = filter;
  }

  // Grand total (all prescriptions matched)
  const grandTotalAgg = await Prescription.aggregate([
    { $match: matchStage },
    { $count: "total" },
  ]);
  const grandTotal = grandTotalAgg[0]?.total || 0;

  // Aggregate prescriptions per hospital
  const prescAgg = await Prescription.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: "$hospitalId",
        totalPrescriptions: { $sum: 1 },
        doctorGenerated: {
          $sum: { $cond: [{ $eq: ["$source", "doctor_generated"] }, 1, 0] },
        },
        patientUploaded: {
          $sum: { $cond: [{ $eq: ["$source", "patient_uploaded"] }, 1, 0] },
        },
        lastPrescription: { $max: "$createdAt" },
        firstPrescription: { $min: "$createdAt" },
      },
    },
    {
      $lookup: {
        from: "hospitals",
        localField: "_id",
        foreignField: "_id",
        as: "hospital",
      },
    },
    { $unwind: { path: "$hospital", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        hospitalId: "$_id",
        hospitalName: { $ifNull: ["$hospital.name", "Unknown"] },
        hospitalCode: { $ifNull: ["$hospital.hospitalCode", "—"] },
        hospitalCity: { $ifNull: ["$hospital.city", ""] },
        hospitalStatus: { $ifNull: ["$hospital.status", "Unknown"] },
        totalPrescriptions: 1,
        doctorGenerated: 1,
        patientUploaded: 1,
        lastPrescription: 1,
        firstPrescription: 1,
      },
    },
  ]);

  // Apply sort
  const sortFns = {
    mostPrescriptions: (a, b) => b.totalPrescriptions - a.totalPrescriptions,
    leastPrescriptions: (a, b) => a.totalPrescriptions - b.totalPrescriptions,
    newest: (a, b) => new Date(b.lastPrescription) - new Date(a.lastPrescription),
    oldest: (a, b) => new Date(a.lastPrescription) - new Date(b.lastPrescription),
    alphabetical: (a, b) => a.hospitalName.localeCompare(b.hospitalName),
  };
  prescAgg.sort(sortFns[sort] || sortFns.mostPrescriptions);

  const total = prescAgg.length;
  const paginated = prescAgg.slice(skip, skip + limit);

  res.status(200).json({
    success: true,
    data: {
      hospitals: paginated,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      grandTotal,
    },
  });
});
