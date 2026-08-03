const Receipt = require("../models/Receipt");
const Patient = require("../models/Patient");
const Doctor = require("../models/Doctor");
const Hospital = require("../models/Hospital");
const User = require("../models/User");
const ReceiptTemplate = require("../models/ReceiptTemplate");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const recordActivity = require("../utils/recordActivity");
const { getS3Client, getBucketName } = require("../utils/s3Client");
const { getMediaObjectBuffer } = require("../utils/mediaStorage");
const { generateReceiptPdfBuffer } = require("../utils/receiptPdf");
const { PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { trackUpload, STORAGE_MODULES } = require("../utils/storageTracker");

// Pre-signed URL expiration time (e.g. 1 hour)
const SIGNED_URL_TTL_SECONDS = 60 * 60;

// Unique receipt number generator: RCP-YYYY-XXXXXX
const generateUniqueReceiptNumber = async () => {
  const currentYear = new Date().getFullYear();
  const yearPrefix = `RCP-${currentYear}-`;

  const latestReceipt = await Receipt.findOne({
    receiptNumber: new RegExp(`^${yearPrefix}`),
  })
    .sort({ receiptNumber: -1 })
    .lean();

  let nextSequence = 1;
  if (latestReceipt) {
    const lastNumStr = latestReceipt.receiptNumber.replace(yearPrefix, "");
    const lastNum = parseInt(lastNumStr, 10);
    if (!isNaN(lastNum)) {
      nextSequence = lastNum + 1;
    }
  }

  return `${yearPrefix}${String(nextSequence).padStart(6, "0")}`;
};

// Helper: build filter based on user role and query params
const buildReceiptFilter = async (req) => {
  const filter = { hospitalId: req.user.hospitalId };

  if (req.user.role === "Doctor") {
    const doctorProfile = await Doctor.findOne({
      hospitalId: req.user.hospitalId,
      $or: [{ userId: req.user._id }, { email: req.user.email }],
    });
    if (!doctorProfile) {
      throw new AppError("Doctor profile not found.", 404);
    }
    filter.doctorId = doctorProfile._id;
  }

  if (req.query.receiptNumber) {
    filter.receiptNumber = { $regex: req.query.receiptNumber, $options: "i" };
  }

  if (req.query.patientName) {
    const nameRegex = new RegExp(req.query.patientName, "i");
    const patients = await Patient.find({
      hospitalId: req.user.hospitalId,
      $or: [{ firstName: nameRegex }, { lastName: nameRegex }],
    }).select("_id");
    const patientIds = patients.map((p) => p._id);
    filter.patientId = { $in: patientIds };
  }

  if (req.query.dateFrom || req.query.dateTo) {
    filter.createdAt = {};
    if (req.query.dateFrom) {
      filter.createdAt.$gte = new Date(req.query.dateFrom);
    }
    if (req.query.dateTo) {
      const dateTo = new Date(req.query.dateTo);
      dateTo.setHours(23, 59, 59, 999);
      filter.createdAt.$lte = dateTo;
    }
  }

  return filter;
};

// ─── POST /api/v1/receipts (Create receipt) ───────────────────────────────────
exports.createReceipt = catchAsync(async (req, res, next) => {
  const {
    patientId,
    doctorId,
    discount = 0,
    tax = 0,
    paidAmount,
    admissionId,
    lineItems,
    consultationType,
    description,
  } = req.body;
  const hospitalId = req.user.hospitalId;

  if (!patientId || !doctorId || paidAmount === undefined) {
    return next(new AppError("Patient, Doctor, and Paid Amount are required.", 400));
  }

  // Retrieve Doctor consultation fee
  const doctor = await Doctor.findById(doctorId);
  if (!doctor) {
    return next(new AppError("Doctor profile not found.", 404));
  }

  let subtotal = 0;
  if (lineItems && Array.isArray(lineItems) && lineItems.length > 0) {
    subtotal = lineItems.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  } else {
    subtotal = doctor.consultationFee || 0;
  }

  const amount = subtotal - Number(discount);
  const dueAmount = Math.max(0, amount - Number(paidAmount));

  // Role validation for Doctors
  if (req.user.role === "Doctor") {
    const doctorProfile = await Doctor.findOne({
      hospitalId,
      $or: [{ userId: req.user._id }, { email: req.user.email }],
    });
    if (!doctorProfile || doctorProfile._id.toString() !== doctorId.toString()) {
      return next(new AppError("You can only generate receipts for your own consultations.", 403));
    }
  }

  // Create receipt record with retry loop to ensure unique receiptNumber
  let receipt;
  let retries = 5;

  while (retries > 0) {
    try {
      const receiptNumber = await generateUniqueReceiptNumber();
      receipt = await Receipt.create({
        receiptNumber,
        hospitalId,
        patientId,
        doctorId,
        admissionId: admissionId || null,
        lineItems: lineItems || [],
        consultationType: consultationType || "",
        description: description || "",
        subtotal,
        discount,
        tax,
        amount,
        paidAmount,
        dueAmount,
        pdfUrl: "temp", // Temp placeholder
        createdBy: req.user._id,
      });
      break;
    } catch (err) {
      if (err.code === 11000 && retries > 1) {
        retries -= 1;
        continue;
      }
      return next(err);
    }
  }

  // Generate Receipt PDF
  const patient = await Patient.findById(patientId);
  const hospital = await Hospital.findById(hospitalId);

  const Appointment = require("../models/Appointment");
  const linkedAppointment = await Appointment.findOne({ patientRecordId: patientId, patientUserId: { $ne: null } }).select("patientUserId").lean();
  const patientUserId = linkedAppointment?.patientUserId;

  let hospitalLogoBuffer = null;
  if (hospital && hospital.logoUrl) {
    try {
      hospitalLogoBuffer = await getMediaObjectBuffer(hospital.logoUrl);
    } catch (err) {
      // Silently fall back to no logo on S3 error
    }
  }

  const pdfBuffer = await generateReceiptPdfBuffer({
    receipt,
    patient,
    doctor,
    hospital,
    hospitalLogoBuffer,
    patientUserId,
  });

  // S3 upload key structure: s3://receipts/{hospitalId}/{patientId}/{year}/{month}/
  const dateObj = new Date();
  const year = dateObj.getFullYear();
  const month = String(dateObj.getMonth() + 1).padStart(2, "0");
  const s3Key = `receipts/${hospitalId}/${patientId}/${year}/${month}/${receipt.receiptNumber}.pdf`;

  const s3Client = getS3Client();
  const bucketName = getBucketName();

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
      Body: pdfBuffer,
      ContentType: "application/pdf",
      ContentDisposition: `inline; filename="receipt-${receipt.receiptNumber}.pdf"`,
    })
  );

  // ── Storage tracking (fire-and-forget) ────────────────────────────────────
  void trackUpload({
    hospitalId,
    bucket: bucketName,
    s3Key,
    originalName: `receipt-${receipt.receiptNumber}.pdf`,
    fileName: `receipt-${receipt.receiptNumber}.pdf`,
    module: STORAGE_MODULES.RECEIPT,
    mimeType: "application/pdf",
    fileSizeBytes: pdfBuffer.length,
    uploadedBy: req.user?._id,
    uploadedByModel: "User",
  });

  // Update receipt with final pdf S3 key
  receipt.pdfUrl = s3Key;
  await receipt.save();

  await recordActivity({
    action: "RECEIPT_CREATED",
    entity: "Receipt",
    entityId: receipt._id,
    user: req.user,
    description: `Receipt ${receipt.receiptNumber} generated for patient ${patient?.firstName || ""} ${patient?.lastName || ""}`,
    ip: req.ip,
  });

  res.status(201).json({
    success: true,
    message: "Receipt generated successfully.",
    data: receipt,
  });
});

// ─── GET /api/v1/receipts (List receipts) ─────────────────────────────────────
exports.getReceipts = catchAsync(async (req, res, next) => {
  const filter = await buildReceiptFilter(req);

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;

  const [receipts, total] = await Promise.all([
    Receipt.find(filter)
      .populate("patientId", "firstName lastName phone email gender age")
      .populate("doctorId", "firstName lastName specialization department")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Receipt.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    total,
    page,
    pages: Math.ceil(total / limit),
    limit,
    data: receipts,
  });
});

// ─── GET /api/v1/receipts/:id (Receipt details) ────────────────────────────────
exports.getReceiptDetails = catchAsync(async (req, res, next) => {
  const filter = { _id: req.params.id, hospitalId: req.user.hospitalId };

  if (req.user.role === "Doctor") {
    const doctorProfile = await Doctor.findOne({
      hospitalId: req.user.hospitalId,
      $or: [{ userId: req.user._id }, { email: req.user.email }],
    });
    if (!doctorProfile) {
      return next(new AppError("Doctor profile not found.", 404));
    }
    filter.doctorId = doctorProfile._id;
  }

  const receipt = await Receipt.findOne(filter)
    .populate("patientId", "firstName lastName phone email age gender address")
    .populate("doctorId", "firstName lastName specialization department registrationNumber")
    .populate("hospitalId", "name address phone email website");

  if (!receipt) {
    return next(new AppError("Receipt not found or access denied.", 404));
  }

  res.status(200).json({
    success: true,
    data: receipt,
  });
});

// ─── GET /api/v1/receipts/:id/download (Pre-signed download URL) ───────────────
exports.getReceiptDownload = catchAsync(async (req, res, next) => {
  const filter = { _id: req.params.id, hospitalId: req.user.hospitalId };

  if (req.user.role === "Doctor") {
    const doctorProfile = await Doctor.findOne({
      hospitalId: req.user.hospitalId,
      $or: [{ userId: req.user._id }, { email: req.user.email }],
    });
    if (!doctorProfile) {
      return next(new AppError("Doctor profile not found.", 404));
    }
    filter.doctorId = doctorProfile._id;
  }

  const receipt = await Receipt.findOne(filter);
  if (!receipt) {
    return next(new AppError("Receipt not found or access denied.", 404));
  }

  const s3Client = getS3Client();
  const bucketName = getBucketName();

  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: receipt.pdfUrl,
    ResponseContentDisposition: `inline; filename="receipt-${receipt.receiptNumber}.pdf"`,
    ResponseContentType: "application/pdf",
  });

  const downloadUrl = await getSignedUrl(s3Client, command, {
    expiresIn: SIGNED_URL_TTL_SECONDS,
  });

  await recordActivity({
    action: "RECEIPT_DOWNLOADED",
    entity: "Receipt",
    entityId: receipt._id,
    user: req.user,
    description: `Receipt ${receipt.receiptNumber} PDF downloaded/viewed`,
    ip: req.ip,
  });

  res.status(200).json({
    success: true,
    data: {
      url: downloadUrl,
      expiresIn: SIGNED_URL_TTL_SECONDS,
    },
  });
});

// ─── GET /api/v1/receipts/export (CSV export) ──────────────────────────────────
exports.exportReceipts = catchAsync(async (req, res, next) => {
  const filter = await buildReceiptFilter(req);

  const receipts = await Receipt.find(filter)
    .populate("patientId", "firstName lastName phone")
    .populate("doctorId", "firstName lastName")
    .sort({ createdAt: -1 });

  let csv = "Receipt Number,Date,Patient Name,Patient Phone,Doctor Name,Subtotal,Discount,Tax,Final Amount,Paid Amount,Due Amount,Status\n";
  for (const r of receipts) {
    const dateStr = new Date(r.createdAt).toLocaleDateString("en-IN");
    const pName = [r.patientId?.firstName, r.patientId?.lastName].filter(Boolean).join(" ");
    const dName = [r.doctorId?.firstName, r.doctorId?.lastName].filter(Boolean).join(" ");
    const status = r.dueAmount > 0 ? "Due" : "Paid";
    csv += `"${r.receiptNumber}","${dateStr}","${pName}","${r.patientId?.phone || ""}","Dr. ${dName}",${r.subtotal},${r.discount},${r.tax},${r.amount},${r.paidAmount},${r.dueAmount},"${status}"\n`;
  }

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="receipts-export-${Date.now()}.csv"`);
  res.status(200).send(csv);
});

// ═══════════════════════════════════════════════════════════════════════════
// RECEIPT TEMPLATE CONTROLLERS
// ═══════════════════════════════════════════════════════════════════════════

exports.getReceiptTemplates = catchAsync(async (req, res, next) => {
  const hospitalId = req.user.hospitalId;
  const { search, sort = 'recent' } = req.query;

  const filter = { hospitalId };
  if (search?.trim()) {
    filter.$text = { $search: search.trim() };
  }

  const sortMap = {
    recent: { createdAt: -1 },
    mostUsed: { useCount: -1 },
    name: { templateName: 1 },
  };

  const templates = await ReceiptTemplate.find(filter)
    .sort(sortMap[sort] || { createdAt: -1 })
    .limit(100)
    .lean();

  res.status(200).json({
    success: true,
    data: templates,
  });
});

exports.createReceiptTemplate = catchAsync(async (req, res, next) => {
  const hospitalId = req.user.hospitalId;
  const { templateName, amount, consultationType, description } = req.body;

  if (!templateName?.trim()) {
    return next(new AppError('Template name is required.', 400));
  }
  if (amount === undefined || amount === null || isNaN(Number(amount))) {
    return next(new AppError('A valid amount is required.', 400));
  }

  const template = await ReceiptTemplate.create({
    hospitalId,
    createdBy: req.user._id,
    templateName: templateName.trim(),
    amount: Number(amount),
    consultationType: String(consultationType || '').trim(),
    description: String(description || '').trim(),
  });

  res.status(201).json({
    success: true,
    message: 'Receipt template created.',
    data: template,
  });
});

exports.updateReceiptTemplate = catchAsync(async (req, res, next) => {
  const hospitalId = req.user.hospitalId;

  const template = await ReceiptTemplate.findOne({
    _id: req.params.id,
    hospitalId,
  });

  if (!template) {
    return next(new AppError('Receipt template not found.', 404));
  }

  const { templateName, amount, consultationType, description } = req.body;

  if (templateName !== undefined) template.templateName = String(templateName).trim();
  if (amount !== undefined) template.amount = Number(amount);
  if (consultationType !== undefined) template.consultationType = String(consultationType).trim();
  if (description !== undefined) template.description = String(description).trim();

  await template.save();

  res.status(200).json({
    success: true,
    message: 'Receipt template updated.',
    data: template,
  });
});

exports.deleteReceiptTemplate = catchAsync(async (req, res, next) => {
  const hospitalId = req.user.hospitalId;

  const deleted = await ReceiptTemplate.findOneAndDelete({
    _id: req.params.id,
    hospitalId,
  });

  if (!deleted) {
    return next(new AppError('Receipt template not found.', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Receipt template deleted.',
  });
});

exports.recordReceiptTemplateUse = catchAsync(async (req, res, next) => {
  const hospitalId = req.user.hospitalId;

  const template = await ReceiptTemplate.findOneAndUpdate(
    { _id: req.params.id, hospitalId },
    { $inc: { useCount: 1 }, $set: { lastUsedAt: new Date() } },
    { new: true }
  );

  if (!template) {
    return next(new AppError('Receipt template not found.', 404));
  }

  res.status(200).json({ success: true });
});
