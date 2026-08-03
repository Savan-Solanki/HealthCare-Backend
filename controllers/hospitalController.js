const jwt = require("jsonwebtoken");

const Hospital = require("../models/Hospital");
const User = require("../models/User");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_LOGO_UPLOAD_BYTES,
  UPLOAD_SESSION_TTL_SECONDS,
  buildHospitalLogoObjectKey,
  createMediaUploadUrl,
  deleteMediaObject,
  extensionFromContentType,
  getMediaObjectBuffer,
  resolveStoredMediaDocument,
} = require("../utils/mediaStorage");
const { applyDemoAccessToHospital, createHospitalAuditLog } = require("../utils/hospitalAccess");
const recordActivity = require("../utils/recordActivity");

const HOSPITAL_LOGO_UPLOAD_SESSION_PURPOSE = "hospital-logo-upload";

const getIdString = (value) => {
  if (!value) return "";
  if (typeof value === "object" && value._id) return String(value._id);
  if (typeof value.toHexString === "function") return value.toHexString();
  return String(value);
};

const ensureHospitalAdminAccess = (req, hospital) => {
  if (req.user.role === "Super Admin") return;

  const userHospitalId = getIdString(req.user.hospitalId);
  const targetHospitalId = getIdString(hospital._id);

  if (req.user.role !== "Hospital Admin" || userHospitalId !== targetHospitalId) {
    throw new AppError("You do not have permission to manage this hospital logo.", 403);
  }
};

const mapHospitalWithLogoUrl = async (hospital) => {
  const hospitalObject = hospital.toObject ? hospital.toObject() : hospital;
  const logoUrl = await resolveStoredMediaDocument(hospitalObject.logo);

  return {
    ...hospitalObject,
    logoUrl,
  };
};

// ─── Helper: build filter ─────────────────────────────────────────────────────
const parseNumber = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const buildDateRange = (from, to) => {
  if (!from && !to) return null;

  const range = {};

  if (from) {
    const fromDate = new Date(from);
    if (!Number.isNaN(fromDate.getTime())) {
      range.$gte = fromDate;
    }
  }

  if (to) {
    const toDate = new Date(to);
    if (!Number.isNaN(toDate.getTime())) {
      toDate.setHours(23, 59, 59, 999);
      range.$lte = toDate;
    }
  }

  return Object.keys(range).length ? range : null;
};

const buildFilter = (query) => {
  const filter = { isArchived: { $ne: true } };
  if (query.status) filter.status = query.status;
  if (query.city) filter.city = { $regex: query.city, $options: "i" };
  if (query.type) filter.type = query.type;

  const minBeds = parseNumber(query.minBeds);
  const maxBeds = parseNumber(query.maxBeds);
  if (minBeds !== null || maxBeds !== null) {
    filter.beds = {};
    if (minBeds !== null) filter.beds.$gte = minBeds;
    if (maxBeds !== null) filter.beds.$lte = maxBeds;
  }

  const minDoctors = parseNumber(query.minDoctors);
  const maxDoctors = parseNumber(query.maxDoctors);
  if (minDoctors !== null || maxDoctors !== null) {
    filter.doctors = {};
    if (minDoctors !== null) filter.doctors.$gte = minDoctors;
    if (maxDoctors !== null) filter.doctors.$lte = maxDoctors;
  }

  const dateField = query.dateField === "updatedAt" ? "updatedAt" : "createdAt";
  const dateRange = buildDateRange(query.dateFrom, query.dateTo);
  if (dateRange) {
    filter[dateField] = dateRange;
  }

  if (query.search) {
    filter.$or = [
      { hospitalCode: { $regex: query.search, $options: "i" } },
      { name: { $regex: query.search, $options: "i" } },
      { city: { $regex: query.search, $options: "i" } },
    ];
  }
  return filter;
};

// ─── GET /api/v1/hospitals ────────────────────────────────────────────────────
exports.getAllHospitals = catchAsync(async (req, res, next) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;
  const allowedSortFields = ["createdAt", "updatedAt", "beds", "doctors", "name", "city"];
  const requestedSortBy = typeof req.query.sortBy === "string" ? req.query.sortBy : "createdAt";
  const sortBy = allowedSortFields.includes(requestedSortBy) ? requestedSortBy : "createdAt";
  const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;

  const filter = buildFilter(req.query);

  const [hospitals, total] = await Promise.all([
    Hospital.find(filter)
      .sort({ [sortBy]: sortOrder })
      .skip(skip)
      .limit(limit)
      .populate("adminId", "name email"),
    Hospital.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    total,
    page,
    pages: Math.ceil(total / limit),
    limit,
    data: hospitals,
  });
});

// ─── POST /api/v1/hospitals ───────────────────────────────────────────────────
exports.createHospital = catchAsync(async (req, res, next) => {
  const { accessType, demoDays, ...hospitalData } = req.body;

  if (!hospitalData.name) {
    return next(new AppError("Hospital name is required.", 400));
  }

  const escapedName = hospitalData.name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existingHospital = await Hospital.findOne({
    name: { $regex: new RegExp(`^${escapedName}$`, "i") },
  });

  if (existingHospital) {
    return next(new AppError("A hospital with this name already exists.", 400));
  }

  let hospital = await Hospital.create(hospitalData);
  await createHospitalAuditLog(hospital._id, "Hospital Created", req.user?.email || "System");

  // Apply demo access settings if super admin selected demo mode
  if (req.user.role === "Super Admin" && accessType === "demo") {
    hospital = await applyDemoAccessToHospital({
      hospitalId: hospital._id,
      accessType: "demo",
      demoDays,
      demoStartDate: req.body.demoStartDate,
      performedBy: req.user?.email || "System",
    });
  }

  await recordActivity({
    action: "HOSPITAL_CREATED",
    entity: "Hospital",
    entityId: hospital._id,
    user: req.user,
    description: `Hospital created: ${hospital.name}, ${hospital.city} (${accessType || "permanent"} access)`,
    ip: req.ip,
  });

  res.status(201).json({
    success: true,
    message: "Hospital created successfully.",
    data: hospital,
  });
});

// ─── GET /api/v1/hospitals/:id ────────────────────────────────────────────────
exports.getHospitalById = catchAsync(async (req, res, next) => {
  const hospital = await Hospital.findById(req.params.id).populate(
    "adminId",
    "name email phone"
  );
  if (!hospital) return next(new AppError("No hospital found with that ID.", 404));

  // Also return doctor/staff count from users
  const staffCount = await User.countDocuments({ hospitalId: hospital._id });

  const data = await mapHospitalWithLogoUrl(hospital);

  res.status(200).json({
    success: true,
    data: { ...data, staffCount },
  });
});

// ─── PUT /api/v1/hospitals/:id ────────────────────────────────────────────────
exports.updateHospital = catchAsync(async (req, res, next) => {
  const { accessType, demoDays, ...updateData } = req.body;

  let hospital = await Hospital.findById(req.params.id);
  if (!hospital) return next(new AppError("No hospital found with that ID.", 404));

  if (updateData.name) {
    const escapedName = updateData.name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const existingHospital = await Hospital.findOne({
      _id: { $ne: req.params.id },
      name: { $regex: new RegExp(`^${escapedName}$`, "i") },
    });

    if (existingHospital) {
      return next(new AppError("A hospital with this name already exists.", 400));
    }
  }

  const doctorLimitChanged = updateData.maxDoctors !== undefined && (updateData.maxDoctors === null ? hospital.maxDoctors !== null : Number(updateData.maxDoctors) !== hospital.maxDoctors);

  Object.assign(hospital, updateData);
  await hospital.save();

  await createHospitalAuditLog(hospital._id, "Hospital Updated", req.user?.email || "System");

  if (doctorLimitChanged) {
    await createHospitalAuditLog(hospital._id, "Doctor Limit Updated", req.user?.email || "System");
  }

  if (req.user.role === "Super Admin" && (accessType || demoDays !== undefined)) {
    hospital = await applyDemoAccessToHospital({
      hospitalId: hospital._id,
      accessType: accessType || hospital.accessType || "permanent",
      demoDays,
      demoStartDate: req.body.demoStartDate,
      performedBy: req.user?.email || "System",
    });
  }

  await recordActivity({
    action: "HOSPITAL_UPDATED",
    entity: "Hospital",
    entityId: hospital._id,
    user: req.user,
    description: `Hospital updated: ${hospital.name}`,
    ip: req.ip,
    meta: { fields: Object.keys(req.body) },
  });

  res.status(200).json({
    success: true,
    message: "Hospital updated successfully.",
    data: hospital,
  });
});

// ─── DELETE /api/v1/hospitals/:id ────────────────────────────────────────────
exports.deleteHospital = catchAsync(async (req, res, next) => {
  const hospital = await Hospital.findById(req.params.id);
  if (!hospital) return next(new AppError("No hospital found with that ID.", 404));

  // Soft delete / Move to archive
  hospital.isArchived = true;
  hospital.archivedAt = new Date();
  hospital.archivedBy = req.user._id;
  hospital.archiveReason = req.body.reason || req.query.reason || "No reason provided";
  hospital.status = "Inactive";
  hospital.subscriptionStatus = "expired";
  await hospital.save({ validateBeforeSave: false });

  // Invalidate all active sessions for users assigned to this hospital.
  // Setting refreshToken to null means their next refresh attempt will fail
  // (mismatch), which triggers automatic logout on the frontend.
  // Also mark them Inactive so they cannot log back in.
  await User.updateMany(
    { hospitalId: hospital._id },
    { $set: { refreshToken: null, status: "Inactive" } }
  );

  await recordActivity({
    action: "HOSPITAL_DELETED",
    entity: "Hospital",
    entityId: hospital._id,
    user: req.user,
    description: `Hospital archived / soft deleted: ${hospital.name}`,
    ip: req.ip,
  });

  await createHospitalAuditLog(hospital._id, "Hospital Deleted", req.user?.email || "System");

  res.status(200).json({
    success: true,
    message: "Hospital deleted successfully.",
  });
});

// ─── GET /api/v1/hospitals/:id/stats ─────────────────────────────────────────
exports.getHospitalStats = catchAsync(async (req, res, next) => {
  const hospital = await Hospital.findById(req.params.id);
  if (!hospital) return next(new AppError("No hospital found with that ID.", 404));

  const staffBreakdown = await User.aggregate([
    { $match: { hospitalId: hospital._id } },
    { $group: { _id: "$role", count: { $sum: 1 } } },
  ]);

  const hospitalWithLogo = await mapHospitalWithLogoUrl(hospital);

  res.status(200).json({
    success: true,
    data: {
      hospital: hospitalWithLogo,
      staffBreakdown,
    },
  });
});

exports.createHospitalLogoUploadSession = catchAsync(async (req, res, next) => {
  const hospital = await Hospital.findById(req.params.id);
  if (!hospital) return next(new AppError("No hospital found with that ID.", 404));

  ensureHospitalAdminAccess(req, hospital);

  const contentType = String(req.body.contentType || "").trim().toLowerCase();
  const fileSize = Number(req.body.fileSize);

  if (!ALLOWED_IMAGE_MIME_TYPES.includes(contentType)) {
    return next(new AppError("Upload a JPG, PNG, or WEBP hospital logo.", 400));
  }

  if (!Number.isFinite(fileSize) || fileSize < 1 || fileSize > MAX_LOGO_UPLOAD_BYTES) {
    return next(
      new AppError(`Hospital logo must be ${MAX_LOGO_UPLOAD_BYTES / (1024 * 1024)} MB or smaller.`, 400)
    );
  }

  const objectKey = buildHospitalLogoObjectKey({
    hospitalId: hospital._id,
    extension: extensionFromContentType(contentType),
  });

  const { url, expiresIn } = await createMediaUploadUrl({
    key: objectKey,
    contentType,
    expiresIn: UPLOAD_SESSION_TTL_SECONDS,
  });

  const uploadToken = jwt.sign(
    {
      purpose: HOSPITAL_LOGO_UPLOAD_SESSION_PURPOSE,
      hospitalId: hospital._id.toString(),
      objectKey,
      contentType,
      fileSize,
      uploadedBy: req.user._id.toString(),
    },
    process.env.JWT_SECRET,
    { expiresIn: UPLOAD_SESSION_TTL_SECONDS }
  );

  res.status(200).json({
    success: true,
    message: "Hospital logo upload session created.",
    data: {
      uploadUrl: url,
      uploadToken,
      expiresIn,
      contentType,
    },
  });
});

exports.completeHospitalLogoUpload = catchAsync(async (req, res, next) => {
  const hospital = await Hospital.findById(req.params.id);
  if (!hospital) return next(new AppError("No hospital found with that ID.", 404));

  ensureHospitalAdminAccess(req, hospital);

  const uploadToken = String(req.body.uploadToken || "").trim();
  if (!uploadToken) {
    return next(new AppError("Upload session expired. Please try again.", 400));
  }

  let decoded;
  try {
    decoded = jwt.verify(uploadToken, process.env.JWT_SECRET);
  } catch {
    return next(new AppError("Upload session expired. Please try again.", 400));
  }

  if (
    decoded.purpose !== HOSPITAL_LOGO_UPLOAD_SESSION_PURPOSE ||
    decoded.hospitalId !== hospital._id.toString()
  ) {
    return next(new AppError("Upload session is invalid. Please try again.", 400));
  }

  let imageBuffer;
  try {
    imageBuffer = await getMediaObjectBuffer(decoded.objectKey);
  } catch {
    return next(new AppError("Upload the hospital logo before completing.", 400));
  }

  if (!imageBuffer.length || imageBuffer.length > MAX_LOGO_UPLOAD_BYTES) {
    return next(new AppError("Uploaded hospital logo is too large.", 413));
  }

  if (imageBuffer.length > Number(decoded.fileSize) + 64 * 1024) {
    return next(new AppError("Uploaded file does not match the selected hospital logo.", 400));
  }

  if (hospital.logo?.key && hospital.logo.key !== decoded.objectKey) {
    try {
      await deleteMediaObject(hospital.logo.key);
    } catch {
      // Ignore cleanup failures for replaced logos.
    }
  }

  hospital.logo = {
    bucket: process.env.AWS_S3_BUCKET,
    key: decoded.objectKey,
    contentType: decoded.contentType,
    size: imageBuffer.length,
    uploadedAt: new Date(),
  };
  hospital.logoUrl = decoded.objectKey;

  await hospital.save();

  await recordActivity({
    action: "HOSPITAL_LOGO_UPDATED",
    entity: "Hospital",
    entityId: hospital._id,
    user: req.user,
    description: `Hospital logo updated: ${hospital.name}`,
    ip: req.ip,
  });

  const data = await mapHospitalWithLogoUrl(hospital);

  res.status(200).json({
    success: true,
    message: "Hospital logo updated successfully.",
    data,
  });
});
