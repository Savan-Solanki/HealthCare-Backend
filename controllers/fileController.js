const mongoose = require("mongoose");
const Prescription = require("../models/Prescription");
const Report = require("../models/Report");
const PatientUser = require("../models/PatientUser");
const Patient = require("../models/Patient");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { createPrescriptionDownloadUrl } = require("../utils/prescriptionStorage");
const { createReportDownloadUrl } = require("../utils/reportStorage");

const normalizeEmail = (email) => (email ? String(email).trim().toLowerCase() : "");

const getPatientRecordOwnerFilters = (patientUser) => {
  const filters = [];
  const email = normalizeEmail(patientUser.email);
  if (email) filters.push({ email });
  return filters;
};

const buildPatientPrescriptionOwnerFilters = async (patientUser) => {
  const patientFilters = getPatientRecordOwnerFilters(patientUser);
  const patientRecords = patientFilters.length
    ? await Patient.find({ $or: patientFilters }).select("_id").lean()
    : [];
  const patientRecordIds = patientRecords.map((record) => record._id);

  const ownerFilters = [
    { patientUserId: patientUser._id },
    { uploadedByPatientUserId: patientUser._id },
  ];

  if (patientRecordIds.length) {
    ownerFilters.push({ patientId: { $in: patientRecordIds } });
  }

  return ownerFilters;
};

const buildPrescriptionFileName = (prescription) => {
  const sanitizeFileName = (name) =>
    String(name || "")
      .trim()
      .replace(/[^a-zA-Z0-9]/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 100);

  return `${sanitizeFileName(prescription.patientName)}-${sanitizeFileName(prescription._id)}.pdf`;
};

exports.downloadFile = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return next(new AppError("Invalid file ID format.", 400));
  }

  // 1. Try to find the document in Report first
  let report = await Report.findById(id);
  if (report) {
    // Verify permissions for Report
    if (req.userType === "patient") {
      if (report.userId.toString() !== req.user._id.toString()) {
        return next(new AppError("You do not have permission to access this report.", 403));
      }
    } else if (req.userType === "staff") {
      const patientUser = await PatientUser.findById(report.userId);
      if (!patientUser) {
        return next(new AppError("Report patient user not found.", 404));
      }
      const email = normalizeEmail(patientUser.email);
      const hasAccess = await Patient.exists({
        hospitalId: req.user.hospitalId,
        email,
      });
      if (!hasAccess) {
        return next(new AppError("You do not have permission to access this patient's report.", 403));
      }
    }

    if (!report.s3Key) {
      return next(new AppError("File storage key not found.", 404));
    }

    // Generate fresh pre-signed S3 URL
    const { url } = await createReportDownloadUrl({
      key: report.s3Key,
      fileName: report.fileName,
      contentType: report.contentType,
      expiresIn: 3600, // 1 hour
    });

    const wantsRedirect = req.query.redirect === "true" || !req.accepts("json");
    if (wantsRedirect) {
      return res.redirect(302, url);
    }
    return res.status(200).json({
      success: true,
      data: { url },
    });
  }

  // 2. Try to find in Prescription
  let prescription = await Prescription.findById(id);
  if (prescription) {
    // Verify permissions for Prescription
    if (req.userType === "patient") {
      const ownerFilters = await buildPatientPrescriptionOwnerFilters(req.user);
      const hasAccess = await Prescription.exists({
        _id: id,
        $or: ownerFilters,
      });
      if (!hasAccess) {
        return next(new AppError("You do not have permission to access this prescription.", 403));
      }
    } else if (req.userType === "staff") {
      const isOwnerDoctor = prescription.doctorUserId && prescription.doctorUserId.toString() === req.user._id.toString();
      const isSameHospital = prescription.hospitalId && prescription.hospitalId.toString() === req.user.hospitalId?.toString();
      if (!isOwnerDoctor && !isSameHospital) {
        return next(new AppError("You do not have permission to access this prescription.", 403));
      }
    }

    if (!prescription.document?.key) {
      return next(new AppError("Prescription file is not available.", 404));
    }

    // Generate fresh pre-signed S3 URL
    const { url } = await createPrescriptionDownloadUrl({
      key: prescription.document.key,
      fileName: prescription.document.fileName || buildPrescriptionFileName(prescription),
      contentType: prescription.document.contentType || "application/pdf",
      expiresIn: 3600, // 1 hour
    });

    const wantsRedirect = req.query.redirect === "true" || !req.accepts("json");
    if (wantsRedirect) {
      return res.redirect(302, url);
    }
    return res.status(200).json({
      success: true,
      data: { url },
    });
  }

  return next(new AppError("File or document not found.", 404));
});
