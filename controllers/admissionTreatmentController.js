const AdmissionTreatment = require("../models/AdmissionTreatment");
const Admission = require("../models/Admission");
const Doctor = require("../models/Doctor");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const recordActivity = require("../utils/recordActivity");
const mongoose = require("mongoose");

const updateAdmissionTotalBill = async (admissionId) => {
  const result = await AdmissionTreatment.aggregate([
    { $match: { admissionId: new mongoose.Types.ObjectId(admissionId), isDeleted: false } },
    { $group: { _id: null, total: { $sum: "$totalAmount" } } },
  ]);
  const total = result.length > 0 ? result[0].total : 0;
  await Admission.findByIdAndUpdate(admissionId, { totalBill: total });
  return total;
};

exports.createTreatment = catchAsync(async (req, res, next) => {
  const { admissionId } = req.params;
  const { dateAndTime, category, treatmentName, description, quantity, unit, unitPrice, notes } = req.body;

  if (!category || !treatmentName || quantity === undefined || unitPrice === undefined) {
    return next(new AppError("Category, name, quantity and unit price are required.", 400));
  }

  const admission = await Admission.findOne({ _id: admissionId, hospitalId: req.user.hospitalId });
  if (!admission) {
    return next(new AppError("Admission record not found.", 404));
  }

  if (admission.status === "Discharged") {
    return next(new AppError("Cannot add treatments for discharged patients.", 400));
  }

  // Prevent duplicates within 1 minute window
  const checkTime = dateAndTime ? new Date(dateAndTime) : new Date();
  const duplicate = await AdmissionTreatment.findOne({
    admissionId,
    category,
    treatmentName: { $regex: new RegExp(`^${treatmentName.trim()}$`, "i") },
    dateAndTime: {
      $gte: new Date(checkTime.getTime() - 60000),
      $lte: new Date(checkTime.getTime() + 60000),
    },
    unitPrice,
    isDeleted: false,
  });

  if (duplicate) {
    return next(new AppError("A duplicate treatment entry already exists within this minute.", 400));
  }

  const treatment = new AdmissionTreatment({
    admissionId,
    patientRecordId: admission.patientRecordId,
    hospitalId: admission.hospitalId,
    dateAndTime: checkTime,
    category,
    treatmentName: treatmentName.trim(),
    description: description || "",
    quantity,
    unit: unit || "Qty",
    unitPrice,
    notes: notes || "",
    addedBy: req.user._id,
    addedByName: req.user.name,
  });

  treatment.auditLogs.push({
    action: "CREATED",
    details: `Treatment created: ${quantity} ${unit || "Qty"} of ${treatmentName} @ ₹${unitPrice} each.`,
    performedBy: req.user._id,
    performedByName: req.user.name,
  });

  await treatment.save();

  // Update totalBill in Admission
  await updateAdmissionTotalBill(admissionId);

  // Add system audit log for Admission
  admission.auditLogs.push({
    action: "TREATMENT_ADDED",
    details: `Logged ${category} treatment: ${treatmentName} for ₹${treatment.totalAmount}.`,
    date: new Date(),
    performedBy: req.user._id,
    performedByName: req.user.name,
  });
  await admission.save();

  res.status(201).json({
    success: true,
    message: "Treatment logged successfully.",
    data: treatment,
  });
});

exports.getTreatments = catchAsync(async (req, res, next) => {
  const { admissionId } = req.params;
  const { category, dateFrom, dateTo, search } = req.query;

  const filter = { admissionId, isDeleted: false };

  if (category && category !== "all") {
    filter.category = category;
  }

  if (dateFrom || dateTo) {
    filter.dateAndTime = {};
    if (dateFrom) {
      filter.dateAndTime.$gte = new Date(dateFrom);
    }
    if (dateTo) {
      const dTo = new Date(dateTo);
      dTo.setHours(23, 59, 59, 999);
      filter.dateAndTime.$lte = dTo;
    }
  }

  if (search) {
    filter.treatmentName = { $regex: String(search).trim(), $options: "i" };
  }

  const treatments = await AdmissionTreatment.find(filter).sort({ dateAndTime: -1 });

  res.status(200).json({
    success: true,
    total: treatments.length,
    data: treatments,
  });
});

exports.updateTreatment = catchAsync(async (req, res, next) => {
  const { admissionId, treatmentId } = req.params;
  const { dateAndTime, category, treatmentName, description, quantity, unit, unitPrice, notes } = req.body;

  const admission = await Admission.findOne({ _id: admissionId, hospitalId: req.user.hospitalId });
  if (!admission) {
    return next(new AppError("Admission record not found.", 404));
  }

  if (admission.status === "Discharged") {
    return next(new AppError("Cannot edit treatments for discharged patients.", 400));
  }

  const treatment = await AdmissionTreatment.findOne({ _id: treatmentId, admissionId, isDeleted: false });
  if (!treatment) {
    return next(new AppError("Treatment record not found.", 404));
  }

  const prevName = treatment.treatmentName;
  const prevAmount = treatment.totalAmount;

  if (dateAndTime !== undefined) treatment.dateAndTime = new Date(dateAndTime);
  if (category !== undefined) treatment.category = category;
  if (treatmentName !== undefined) treatment.treatmentName = treatmentName.trim();
  if (description !== undefined) treatment.description = description;
  if (quantity !== undefined) treatment.quantity = quantity;
  if (unit !== undefined) treatment.unit = unit;
  if (unitPrice !== undefined) treatment.unitPrice = unitPrice;
  if (notes !== undefined) treatment.notes = notes;

  treatment.auditLogs.push({
    action: "UPDATED",
    details: `Treatment modified from ${prevName} (₹${prevAmount}) to ${treatment.treatmentName} (₹${treatment.quantity * treatment.unitPrice}).`,
    performedBy: req.user._id,
    performedByName: req.user.name,
  });

  await treatment.save();

  // Update totalBill in Admission
  await updateAdmissionTotalBill(admissionId);

  // Add system audit log for Admission
  admission.auditLogs.push({
    action: "TREATMENT_EDITED",
    details: `Updated treatment entry: ${treatment.treatmentName} (New Total: ₹${treatment.totalAmount}).`,
    date: new Date(),
    performedBy: req.user._id,
    performedByName: req.user.name,
  });
  await admission.save();

  res.status(200).json({
    success: true,
    message: "Treatment entry updated successfully.",
    data: treatment,
  });
});

exports.deleteTreatment = catchAsync(async (req, res, next) => {
  const { admissionId, treatmentId } = req.params;

  const admission = await Admission.findOne({ _id: admissionId, hospitalId: req.user.hospitalId });
  if (!admission) {
    return next(new AppError("Admission record not found.", 404));
  }

  if (admission.status === "Discharged") {
    return next(new AppError("Cannot remove treatments for discharged patients.", 400));
  }

  const treatment = await AdmissionTreatment.findOne({ _id: treatmentId, admissionId, isDeleted: false });
  if (!treatment) {
    return next(new AppError("Treatment record not found.", 404));
  }

  treatment.isDeleted = true;
  treatment.auditLogs.push({
    action: "DELETED",
    details: `Treatment entry for ${treatment.treatmentName} deleted.`,
    performedBy: req.user._id,
    performedByName: req.user.name,
  });
  await treatment.save();

  // Update totalBill in Admission
  await updateAdmissionTotalBill(admissionId);

  // Add system audit log for Admission
  admission.auditLogs.push({
    action: "TREATMENT_DELETED",
    details: `Removed treatment entry: ${treatment.treatmentName} (₹${treatment.totalAmount}).`,
    date: new Date(),
    performedBy: req.user._id,
    performedByName: req.user.name,
  });
  await admission.save();

  res.status(200).json({
    success: true,
    message: "Treatment entry removed successfully.",
  });
});

exports.getBillingSummary = catchAsync(async (req, res, next) => {
  const { admissionId } = req.params;

  const admission = await Admission.findOne({ _id: admissionId, hospitalId: req.user.hospitalId });
  if (!admission) {
    return next(new AppError("Admission record not found.", 404));
  }

  const treatments = await AdmissionTreatment.find({ admissionId, isDeleted: false });

  let subtotal = 0;
  const categoriesMap = {};

  treatments.forEach((t) => {
    subtotal += t.totalAmount;
    if (!categoriesMap[t.category]) {
      categoriesMap[t.category] = {
        category: t.category,
        count: 0,
        amount: 0,
      };
    }
    categoriesMap[t.category].count += t.quantity;
    categoriesMap[t.category].amount += t.totalAmount;
  });

  const admittingDoctor = admission.doctorId ? await Doctor.findById(admission.doctorId) : null;
  const consultationFee = admittingDoctor?.consultationFee || 0;

  if (consultationFee > 0) {
    if (!categoriesMap["Consultation"]) {
      categoriesMap["Consultation"] = {
        category: "Consultation",
        count: 0,
        amount: 0,
      };
    }
    categoriesMap["Consultation"].count += 1;
    categoriesMap["Consultation"].amount += consultationFee;
    subtotal += consultationFee;
  }

  const categoriesBreakdown = Object.values(categoriesMap);

  // Default GST to 18% (Inclusive)
  const gstRate = 0.18;
  const tax = Math.round(subtotal * gstRate * 100) / 100;
  const total = subtotal; // Inclusive GST, don't add to grand total

  res.status(200).json({
    success: true,
    data: {
      subtotal,
      tax,
      discount: 0,
      total,
      categoriesBreakdown,
      itemsCount: treatments.length + (consultationFee > 0 ? 1 : 0),
    },
  });
});
