const Admission = require("../models/Admission");
const Appointment = require("../models/Appointment");
const Patient = require("../models/Patient");
const Hospital = require("../models/Hospital");
const User = require("../models/User");
const PatientUser = require("../models/PatientUser");
const Receipt = require("../models/Receipt");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { sendPushNotification } = require("../utils/pushNotifications");
const { emitToPatient, emitToHospital } = require("../utils/realtimeEvents");
const { generateAdmissionSlipPdfBuffer } = require("../utils/admissionSlipPdf");
const { getMediaObjectBuffer } = require("../utils/mediaStorage");
const { sendCSV } = require("../utils/csvExport");
const recordActivity = require("../utils/recordActivity");
const mongoose = require("mongoose");
const PDFDocument = require("pdfkit");

const getIdString = (value) => {
  if (!value) return "";
  if (typeof value === "object" && value._id) return String(value._id);
  if (typeof value.toHexString === "function") return value.toHexString();
  return String(value);
};

// ─── POST /hospital-admin/admissions ─────────────────────────────────────────
exports.admitPatient = catchAsync(async (req, res, next) => {
  const { appointmentId, admissionReason, roomNumber, bedNumber, notes } = req.body;

  if (!appointmentId || !admissionReason) {
    return next(new AppError("Appointment ID and admission reason are required.", 400));
  }

  const appointment = await Appointment.findById(appointmentId).populate("patientRecordId");
  if (!appointment) {
    return next(new AppError("No appointment found with that ID.", 404));
  }

  if (appointment.isAdmitted) {
    return next(new AppError("Patient is already admitted for this appointment.", 400));
  }

  const hospitalId = appointment.hospitalId;
  const hospital = await Hospital.findById(hospitalId);
  if (!hospital) {
    return next(new AppError("Hospital not found.", 404));
  }

  // Generate unique admissionId
  const count = await Admission.countDocuments({ hospitalId });
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const admissionId = `ADM-${dateStr}-${String(count + 1).padStart(4, "0")}`;

  // Get patient details from record or appointment snapshot
  let patientRecord = appointment.patientRecordId;
  if (!patientRecord) {
    // Automatically find or create a Patient record if it is missing from the appointment
    const parts = String(appointment.patientName || "").trim().split(/\s+/);
    const firstName = parts[0] || "Patient";
    const lastName = parts.slice(1).join(" ") || "Record";

    let existingPatient = null;
    if (appointment.patientPhone) {
      existingPatient = await Patient.findOne({
        hospitalId,
        firstName,
        lastName,
        phone: appointment.patientPhone,
      });
    } else {
      existingPatient = await Patient.findOne({
        hospitalId,
        firstName,
        lastName,
      });
    }

    if (existingPatient) {
      patientRecord = existingPatient;
    } else {
      patientRecord = await Patient.create({
        hospitalId,
        firstName,
        lastName,
        email: appointment.patientEmail || null,
        phone: appointment.patientPhone || null,
        status: "Active",
      });
    }

    // Link the newly found/created patient record back to the appointment
    appointment.patientRecordId = patientRecord._id;
    await appointment.save();
  }

  const patientName = appointment.patientName;
  const patientEmail = appointment.patientEmail || patientRecord?.email || null;
  const patientPhone = appointment.patientPhone || patientRecord?.phone || null;

  // Create Admission document
  const admission = await Admission.create({
    admissionId,
    patientRecordId: patientRecord._id,
    patientName,
    patientEmail,
    patientPhone,
    appointmentId: appointment._id,
    doctorId: appointment.doctorId,
    doctorName: appointment.doctorName,
    hospitalId,
    department: appointment.department || "General Medicine",
    admissionDate: new Date(),
    admittedBy: req.user._id,
    admittedByRole: req.user.role,
    admissionReason,
    roomNumber: roomNumber || null,
    bedNumber: bedNumber || null,
    notes: notes || null,
    status: "Admitted",
    auditLogs: [
      {
        action: "ADMITTED",
        details: `Admitted under Dr. ${appointment.doctorName}. Room: ${roomNumber || "N/A"}, Bed: ${bedNumber || "N/A"}`,
        date: new Date(),
        performedBy: req.user._id,
        performedByName: req.user.name,
      },
    ],
  });

  // Update Appointment status to Admitted and set isAdmitted true
  appointment.isAdmitted = true;
  appointment.status = "Admitted";
  await appointment.save();

  // Log system activity
  await recordActivity({
    action: "PATIENT_ADMITTED",
    entity: "Admission",
    entityId: admission._id,
    user: req.user,
    description: `Patient ${patientName} admitted under Dr. ${appointment.doctorName}. Admission ID: ${admissionId}`,
    ip: req.ip,
  });

  // Real-time Socket.IO Broadcast
  const patientUserId = appointment.patientUserId;
  if (patientUserId) {
    emitToPatient(getIdString(patientUserId), "admission_created", {
      admissionId: admission.admissionId,
      status: admission.status,
      doctorName: admission.doctorName,
      department: admission.department,
      roomNumber: admission.roomNumber,
      bedNumber: admission.bedNumber,
      hospitalName: hospital.name,
    });
  }
  emitToHospital(getIdString(hospitalId), "admission_created", admission);

  // Send Firebase Push Notification
  try {
    const contactFilters = [];
    if (patientEmail) contactFilters.push({ email: patientEmail.trim().toLowerCase() });
    if (patientPhone) contactFilters.push({ phone: patientPhone.trim() });

    if (contactFilters.length) {
      const patientUser = await PatientUser.findOne({ $or: contactFilters }).select("fcmToken");
      if (patientUser?.fcmToken) {
        await sendPushNotification(patientUser.fcmToken, {
          title: "Hospital Admission Confirmed",
          body: `You have been admitted to ${hospital.name} under Dr. ${appointment.doctorName}. Please check your admission details.`,
          data: { type: "admission", admissionId: String(admission._id) },
        });
      }
    }
  } catch (pushErr) {
    console.error("[Admission] Failed to send push notification:", pushErr);
  }

  res.status(201).json({
    success: true,
    message: "Patient admitted successfully.",
    data: admission,
  });
});

// ─── GET /hospital-admin/admissions ─────────────────────────────────────────
exports.getAdmissions = catchAsync(async (req, res, next) => {
  const hospitalId = req.user.hospitalId;
  const { status, search } = req.query;

  const filter = { hospitalId };

  if (status && status !== "all") {
    filter.status = status;
  }

  if (search) {
    const queryStr = String(search).trim();
    if (mongoose.Types.ObjectId.isValid(queryStr)) {
      filter.$or = [{ _id: queryStr }, { patientRecordId: queryStr }];
    } else {
      filter.$or = [
        { admissionId: { $regex: queryStr, $options: "i" } },
        { patientName: { $regex: queryStr, $options: "i" } },
        { doctorName: { $regex: queryStr, $options: "i" } },
        { patientEmail: { $regex: queryStr, $options: "i" } },
        { patientPhone: { $regex: queryStr, $options: "i" } },
      ];
    }
  }

  const admissions = await Admission.find(filter)
    .populate("patientRecordId", "firstName lastName age gender bloodGroup phone email")
    .sort({ admissionDate: -1 });

  res.status(200).json({
    success: true,
    total: admissions.length,
    data: admissions,
  });
});

// ─── GET /hospital-admin/admissions/:id ──────────────────────────────────────
exports.getAdmissionDetails = catchAsync(async (req, res, next) => {
  const admission = await Admission.findOne({
    _id: req.params.id,
    hospitalId: req.user.hospitalId,
  }).populate("patientRecordId", "firstName lastName age gender bloodGroup phone email address");

  if (!admission) {
    return next(new AppError("Admission record not found.", 404));
  }

  res.status(200).json({
    success: true,
    data: admission,
  });
});

// ─── PATCH /hospital-admin/admissions/:id/room ───────────────────────────────
exports.updateRoom = catchAsync(async (req, res, next) => {
  const { roomNumber, bedNumber } = req.body;
  const hospitalId = req.user.hospitalId;

  const admission = await Admission.findOne({ _id: req.params.id, hospitalId });
  if (!admission) {
    return next(new AppError("Admission record not found.", 404));
  }

  const sevenDaysInMs = 7 * 24 * 60 * 60 * 1000;
  if (new Date() - new Date(admission.createdAt) > sevenDaysInMs) {
    return next(new AppError("Admission slip cannot be edited after 7 days.", 400));
  }

  admission.roomNumber = roomNumber || null;
  admission.bedNumber = bedNumber || null;

  admission.auditLogs.push({
    action: "ROOM_ASSIGNED",
    details: `Updated assignment: Room ${roomNumber || "N/A"}, Bed ${bedNumber || "N/A"}`,
    date: new Date(),
    performedBy: req.user._id,
    performedByName: req.user.name,
  });

  await admission.save();

  // Socket broadcast
  emitToHospital(getIdString(hospitalId), "admission_updated", admission);

  // Send Push Notification
  try {
    const contactFilters = [];
    if (admission.patientEmail) contactFilters.push({ email: admission.patientEmail.trim().toLowerCase() });
    if (admission.patientPhone) contactFilters.push({ phone: admission.patientPhone.trim() });

    if (contactFilters.length) {
      const patientUser = await PatientUser.findOne({ $or: contactFilters }).select("fcmToken");
      if (patientUser?.fcmToken) {
        await sendPushNotification(patientUser.fcmToken, {
          title: "Room Assigned",
          body: `Your room and bed details have been updated. Room: ${roomNumber || "N/A"}, Bed: ${bedNumber || "N/A"}.`,
          data: { type: "admission", admissionId: String(admission._id) },
        });
      }
    }
  } catch (pushErr) {
    console.error("[Admission] Failed to send room assignment notification:", pushErr);
  }

  res.status(200).json({
    success: true,
    message: "Room and bed assigned successfully.",
    data: admission,
  });
});

// ─── GET /hospital-admin/admissions/stats ────────────────────────────────────
exports.getStats = catchAsync(async (req, res, next) => {
  const hospitalId = req.user.hospitalId;
  const hospital = await Hospital.findById(hospitalId);

  if (!hospital) {
    return next(new AppError("Hospital not found.", 404));
  }

  const [totalAdmissions, activeAdmissions, dischargedAdmissions] = await Promise.all([
    Admission.countDocuments({ hospitalId }),
    Admission.countDocuments({ hospitalId, status: { $ne: "Discharged" } }),
    Admission.countDocuments({ hospitalId, status: "Discharged" }),
  ]);

  const totalBeds = hospital.beds || 0;
  const occupiedBeds = activeAdmissions;
  const availableBeds = Math.max(0, totalBeds - occupiedBeds);

  res.status(200).json({
    success: true,
    data: {
      totalAdmissions,
      activeAdmissions,
      dischargedPatients: dischargedAdmissions,
      occupiedBeds,
      availableBeds,
    },
  });
});

// ─── GET /hospital-admin/admissions/:id/slip ─────────────────────────────────
exports.getSlip = catchAsync(async (req, res, next) => {
  const hospitalId = req.user.hospitalId;
  const admission = await Admission.findOne({ _id: req.params.id, hospitalId }).populate("appointmentId");
  if (!admission) {
    return next(new AppError("Admission record not found.", 404));
  }

  const hospital = await Hospital.findById(hospitalId);
  const patient = await Patient.findById(admission.patientRecordId);

  // Fetch logo buffer
  const logoBuffer = hospital?.logo?.key
    ? await getMediaObjectBuffer(hospital.logo.key).catch(() => null)
    : null;

  const pdfBuffer = await generateAdmissionSlipPdfBuffer({
    hospital,
    patient,
    admission,
    hospitalLogoBuffer: logoBuffer,
  });

  const timestamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="admission-slip-${admission.admissionId}-${timestamp}.pdf"`);
  res.status(200).send(pdfBuffer);
});

// ─── GET /hospital-admin/admissions/reports ─────────────────────────────────
exports.exportReports = catchAsync(async (req, res, next) => {
  const hospitalId = req.user.hospitalId;
  const { reportType, format } = req.query;

  if (!reportType) {
    return next(new AppError("reportType query parameter is required.", 400));
  }

  const filter = { hospitalId };
  const now = new Date();

  if (reportType === "daily") {
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    filter.admissionDate = { $gte: startOfToday };
  } else if (reportType === "monthly") {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    filter.admissionDate = { $gte: startOfMonth };
  } else if (reportType === "discharge") {
    filter.status = "Discharged";
  }

  const admissions = await Admission.find(filter)
    .populate("patientRecordId", "firstName lastName age gender bloodGroup")
    .sort({ admissionDate: -1 });

  const mappedAdmissions = admissions.map((adm) => ({
    admissionId: adm.admissionId,
    patientName: adm.patientName,
    doctorName: adm.doctorName,
    department: adm.department || "General",
    admissionDate: adm.admissionDate ? adm.admissionDate.toISOString().slice(0, 10) : "",
    roomBed: [adm.roomNumber ? `R-${adm.roomNumber}` : null, adm.bedNumber ? `B-${adm.bedNumber}` : null].filter(Boolean).join(" / ") || "N/A",
    status: adm.status,
    reason: adm.admissionReason,
  }));

  if (format === "csv") {
    const fields = ["admissionId", "patientName", "doctorName", "department", "admissionDate", "roomBed", "status", "reason"];
    return sendCSV(res, mappedAdmissions, fields, `${reportType}-admissions-report`);
  }

  // Default: generate simple PDF List
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  doc.on("end", () => {
    res.setHeader("Content-Type", "application/pdf");
    res.status(200).send(Buffer.concat(chunks));
  });

  doc.font("Helvetica-Bold").fontSize(16).fillColor("#1e3a5f")
    .text(`${reportType.toUpperCase()} ADMISSIONS REPORT`, { align: "center" });
  doc.font("Helvetica").fontSize(8).fillColor("#64748b")
    .text(`Generated on ${now.toLocaleDateString("en-IN")}`, { align: "center" });

  doc.moveDown(2);

  // Table header
  const colW = [70, 100, 100, 60, 60, 60];
  const tableX = doc.x;
  const startRowY = doc.y;

  doc.font("Helvetica-Bold").fontSize(8).fillColor("#000000");
  doc.text("Admission ID", tableX, startRowY, { width: colW[0] });
  doc.text("Patient", tableX + colW[0], startRowY, { width: colW[1] });
  doc.text("Doctor", tableX + colW[0] + colW[1], startRowY, { width: colW[2] });
  doc.text("Dept", tableX + colW[0] + colW[1] + colW[2], startRowY, { width: colW[3] });
  doc.text("Date", tableX + colW[0] + colW[1] + colW[2] + colW[3], startRowY, { width: colW[4] });
  doc.text("Status", tableX + colW[0] + colW[1] + colW[2] + colW[3] + colW[4], startRowY, { width: colW[5] });

  doc.moveTo(tableX, doc.y + 2).lineTo(tableX + colW.reduce((a,b)=>a+b, 0), doc.y + 2).strokeColor("#e2e8f0").stroke();

  doc.font("Helvetica").fontSize(8);
  mappedAdmissions.forEach((adm) => {
    doc.y = doc.y + 12;
    const rY = doc.y;
    doc.text(adm.admissionId, tableX, rY, { width: colW[0], lineBreak: false });
    doc.text(adm.patientName, tableX + colW[0], rY, { width: colW[1], lineBreak: false });
    doc.text(adm.doctorName, tableX + colW[0] + colW[1], rY, { width: colW[2], lineBreak: false });
    doc.text(adm.department, tableX + colW[0] + colW[1] + colW[2], rY, { width: colW[3], lineBreak: false });
    doc.text(adm.admissionDate, tableX + colW[0] + colW[1] + colW[2] + colW[3], rY, { width: colW[4], lineBreak: false });
    doc.text(adm.status, tableX + colW[0] + colW[1] + colW[2] + colW[3] + colW[4], rY, { width: colW[5], lineBreak: false });
  });

  doc.end();
});

// ─── GET /patient/admissions ────────────────────────────────────────────────
exports.getPatientAdmissions = catchAsync(async (req, res, next) => {
  const patientEmail = req.user.email;
  const patientPhone = req.user.phone;

  const contactFilters = [];
  if (patientEmail) contactFilters.push({ patientEmail: patientEmail.trim().toLowerCase() });
  if (patientPhone) contactFilters.push({ patientPhone: patientPhone.trim() });

  if (!contactFilters.length) {
    return res.status(200).json({ success: true, data: [] });
  }

  const admissions = await Admission.find({ $or: contactFilters })
    .populate("hospitalId", "name address phone email logoUrl logo")
    .sort({ admissionDate: -1 });

  const formatted = await Promise.all(
    admissions.map(async (adm) => {
      const receipts = await Receipt.find({ admissionId: adm._id }).select("_id receiptNumber paidAmount createdAt");
      return {
        _id: adm._id,
        admissionId: adm.admissionId,
        status: adm.status,
        doctorName: adm.doctorName,
        department: adm.department,
        roomNumber: adm.roomNumber,
        bedNumber: adm.bedNumber,
        admissionDate: adm.admissionDate,
        dischargeDate: adm.dischargeDate,
        hospitalName: adm.hospitalId?.name || "MedKwik Partner Hospital",
        hospitalAddress: adm.hospitalId?.address || "",
        hospitalPhone: adm.hospitalId?.phone || "",
        notes: adm.notes,
        admissionReason: adm.admissionReason,
        receipts: receipts.map((r) => ({
          _id: r._id,
          receiptNumber: r.receiptNumber,
          paidAmount: r.paidAmount,
          createdAt: r.createdAt,
        })),
      };
    })
  );

  res.status(200).json({
    success: true,
    data: formatted,
  });
});

exports.getPatientSlip = catchAsync(async (req, res, next) => {
  const patientEmail = req.user.email;
  const patientPhone = req.user.phone;

  const contactFilters = [];
  if (patientEmail) contactFilters.push({ patientEmail: patientEmail.trim().toLowerCase() });
  if (patientPhone) contactFilters.push({ patientPhone: patientPhone.trim() });

  if (!contactFilters.length) {
    return next(new AppError("You do not have access to this admission slip.", 403));
  }

  const admission = await Admission.findOne({
    _id: req.params.id,
    $or: contactFilters,
  }).populate("appointmentId");

  if (!admission) {
    return next(new AppError("Admission record not found or access denied.", 404));
  }

  const hospitalId = admission.hospitalId;
  const hospital = await Hospital.findById(hospitalId);
  const patient = await Patient.findById(admission.patientRecordId);

  const logoBuffer = hospital?.logo?.key
    ? await getMediaObjectBuffer(hospital.logo.key).catch(() => null)
    : null;

  const pdfBuffer = await generateAdmissionSlipPdfBuffer({
    admission,
    hospital,
    patient,
    hospitalLogoBuffer: logoBuffer,
  });

  res.setHeader("Content-Type", "application/pdf");
  res.status(200).send(pdfBuffer);
});

exports.updateAdmissionStatus = catchAsync(async (req, res, next) => {
  const { status, treatmentNote } = req.body;
  const hospitalId = req.user.hospitalId;

  const admission = await Admission.findOne({ _id: req.params.id, hospitalId });
  if (!admission) {
    return next(new AppError("Admission record not found.", 404));
  }

  const sevenDaysInMs = 7 * 24 * 60 * 60 * 1000;
  if (new Date() - new Date(admission.createdAt) > sevenDaysInMs) {
    return next(new AppError("Admission slip cannot be edited after 7 days.", 400));
  }

  const prevStatus = admission.status;
  admission.status = status;

  if (treatmentNote) {
    admission.notes = treatmentNote;
  }

  admission.auditLogs.push({
    action: "STATUS_CHANGED",
    details: `Status updated from ${prevStatus} to ${status}. Note: ${treatmentNote || "None"}`,
    date: new Date(),
    performedBy: req.user._id,
    performedByName: req.user.name,
  });

  await admission.save();

  // Socket
  emitToHospital(getIdString(hospitalId), "admission_status_changed", admission);

  // FCM
  try {
    const contactFilters = [];
    if (admission.patientEmail) contactFilters.push({ email: admission.patientEmail.trim().toLowerCase() });
    if (admission.patientPhone) contactFilters.push({ phone: admission.patientPhone.trim() });

    if (contactFilters.length) {
      const patientUser = await PatientUser.findOne({ $or: contactFilters }).select("fcmToken");
      if (patientUser?.fcmToken) {
        let msg = `Your admission status has been updated to ${status}.`;
        if (status === "Under Treatment") {
          msg = "You are currently under treatment.";
        }
        await sendPushNotification(patientUser.fcmToken, {
          title: "Admission Status Updated",
          body: msg,
          data: { type: "admission", admissionId: String(admission._id) },
        });
      }
    }
  } catch (pushErr) {
    console.error("[Admission] Failed to send status push notification:", pushErr);
  }

  res.status(200).json({
    success: true,
    message: "Admission status updated successfully.",
    data: admission,
  });
});
