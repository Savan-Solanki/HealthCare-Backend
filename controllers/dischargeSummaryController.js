const DischargeSummary = require("../models/DischargeSummary");
const Admission = require("../models/Admission");
const Appointment = require("../models/Appointment");
const Patient = require("../models/Patient");
const Hospital = require("../models/Hospital");
const Doctor = require("../models/Doctor");
const PatientUser = require("../models/PatientUser");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { sendPushNotification } = require("../utils/pushNotifications");
const { emitToPatient, emitToHospital } = require("../utils/realtimeEvents");
const { generateDischargeSummaryPdfBuffer } = require("../utils/dischargeSummaryPdf");
const { getMediaObjectBuffer } = require("../utils/mediaStorage");
const {
  uploadDischargeSummaryObject,
  createDischargeSummaryDownloadUrl,
} = require("../utils/dischargeSummaryStorage");
const recordActivity = require("../utils/recordActivity");
const mongoose = require("mongoose");
const Receipt = require("../models/Receipt");
const AdmissionTreatment = require("../models/AdmissionTreatment");
const { generateReceiptPdfBuffer } = require("../utils/receiptPdf");
const { getS3Client, getBucketName } = require("../utils/s3Client");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { trackUpload, STORAGE_MODULES } = require("../utils/storageTracker");

const getIdString = (value) => {
  if (!value) return "";
  if (typeof value === "object" && value._id) return String(value._id);
  if (typeof value.toHexString === "function") return value.toHexString();
  return String(value);
};

// ─── POST /doctor/admissions/:admissionId/discharge ──────────────────────────
exports.dischargePatient = catchAsync(async (req, res, next) => {
  const { admissionId } = req.params;
  const {
    diagnosis,
    historyAndClinicalSummary,
    treatmentGiven,
    investigations,
    surgeryProcedureName,
    surgeryDate,
    surgeonName,
    anesthesiologistName,
    surgicalNotes,
    conditionOnDischarge,
    hospitalCourseSummary,
    medications,
    followUpDate,
    followUpInstructions,
    dischargeType,
    isDraft,
  } = req.body;

  if (!diagnosis) {
    return next(new AppError("Diagnosis is required.", 400));
  }

  const admission = await Admission.findById(admissionId);
  if (!admission) {
    return next(new AppError("No admission record found with that ID.", 404));
  }

  // Find or create summary
  let summary = await DischargeSummary.findOne({ admissionId: admission._id });

  if (summary && summary.createdAt) {
    const sevenDaysInMs = 7 * 24 * 60 * 60 * 1000;
    if (new Date() - new Date(summary.createdAt) > sevenDaysInMs) {
      return next(new AppError("Discharge summary cannot be edited after 7 days.", 400));
    }
  }

  if (admission.status === "Discharged" && !isDraft) {
    if (!summary) {
      return next(new AppError("Patient is already discharged.", 400));
    }
  }

  const hospitalId = admission.hospitalId;
  const hospital = await Hospital.findById(hospitalId);
  const patient = await Patient.findById(admission.patientRecordId);
  const doctor = await Doctor.findOne({
    hospitalId,
    $or: [{ userId: req.user._id }, { email: req.user.email }],
  });

  const count = await DischargeSummary.countDocuments({ hospitalId });
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const dischargeId = `DIS-${dateStr}-${String(count + 1).padStart(4, "0")}`;

  if (!summary) {
    summary = new DischargeSummary({
      dischargeId,
      admissionId: admission._id,
      appointmentId: admission.appointmentId,
      patientId: admission.patientRecordId,
      hospitalId,
      doctorId: admission.doctorId,
      patientName: admission.patientName,
      patientAge: patient?.age || null,
      patientGender: patient?.gender || null,
      patientBloodGroup: patient?.bloodGroup || null,
      patientPhone: admission.patientPhone || patient?.phone || null,
      patientAddress: patient?.address || null,
      hospitalName: hospital?.name || "MedKwik Hospital",
      hospitalLogoUrl: hospital?.logoUrl || null,
      hospitalAddress: [hospital?.address, hospital?.city, hospital?.state].filter(Boolean).join(", "),
      hospitalPhone: hospital?.phone || null,
      hospitalEmail: hospital?.email || null,
      hospitalRegistrationNumber: hospital?.registrationNumber || null,
      doctorName: admission.doctorName,
      doctorDepartment: admission.department || doctor?.department || "General",
      doctorRegistrationNumber: doctor?.registrationNumber || null,
      admissionDate: admission.admissionDate,
      dischargeDate: new Date(),
      generatedBy: req.user._id,
      generatedByName: req.user.name,
    });
  }

  // Update clinical information
  summary.diagnosis = diagnosis;
  summary.historyAndClinicalSummary = historyAndClinicalSummary || null;
  summary.treatmentGiven = treatmentGiven || null;
  summary.investigations = investigations || null;
  summary.surgeryProcedureName = surgeryProcedureName || null;
  summary.surgeryDate = surgeryDate ? new Date(surgeryDate) : null;
  summary.surgeonName = surgeonName || null;
  summary.anesthesiologistName = anesthesiologistName || null;
  summary.surgicalNotes = surgicalNotes || null;
  summary.conditionOnDischarge = conditionOnDischarge || null;
  summary.hospitalCourseSummary = hospitalCourseSummary || null;
  summary.dischargeType = dischargeType || "Regular";
  summary.roomNumber = admission.roomNumber;
  summary.bedNumber = admission.bedNumber;
  summary.medications = medications || [];
  summary.followUpDate = followUpDate ? new Date(followUpDate) : null;
  summary.followUpInstructions = followUpInstructions || null;
  summary.isDraft = Boolean(isDraft);

  if (!isDraft) {
    // Perform final discharge operations
    const prevStatus = admission.status;
    admission.status = "Discharged";
    if (prevStatus !== "Discharged") {
      admission.dischargeDate = new Date();
      admission.auditLogs.push({
        action: "DISCHARGED",
        details: `Patient discharged. Summary ID: ${dischargeId}`,
        date: new Date(),
        performedBy: req.user._id,
        performedByName: req.user.name,
      });
    } else {
      admission.auditLogs.push({
        action: "DISCHARGE_SUMMARY_UPDATED",
        details: `Discharge summary updated. Summary ID: ${dischargeId}`,
        date: new Date(),
        performedBy: req.user._id,
        performedByName: req.user.name,
      });
    }
    await admission.save();

    // Automatically complete associated appointment
    if (admission.appointmentId) {
      await Appointment.findByIdAndUpdate(admission.appointmentId, { status: "Completed" });
    }

    // Fetch hospital logo buffer for PDF drawing
    const logoBuffer = hospital?.logo?.key
      ? await getMediaObjectBuffer(hospital.logo.key).catch(() => null)
      : null;

    // Populate appointmentId on summary so we can get patientUserId
    if (summary.appointmentId && !summary.appointmentId.patientUserId) {
      await summary.populate("appointmentId");
    }

    // Load active treatments for this admission
    const treatments = await AdmissionTreatment.find({ admissionId: admission._id, isDeleted: false }).sort({ dateAndTime: 1 });

    // Generate Final Bill Receipt automatically (Treatment charges ONLY — no consultant fee)
    let subtotal = 0;
    const lineItems = treatments.map((t) => {
      const itemAmt = (t.quantity || 1) * (t.unitPrice || 0);
      subtotal += itemAmt;
      return {
        description: `${t.treatmentName} (${t.category})`,
        amount: itemAmt,
      };
    });

    const admittingDoctor = await Doctor.findById(admission.doctorId);
    const consultationFee = admittingDoctor?.consultationFee || 0;
    // NOTE: consultationFee is intentionally NOT added to the main bill —
    // it will be generated as a separate receipt below.

    const amount = subtotal;
    const tax = 0; // No tax on IPD bill
    const paidAmount = amount;
    const dueAmount = 0;

    let finalReceipt = await Receipt.findOne({ admissionId: admission._id });
    if (!finalReceipt) {
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

      const receiptNumber = await generateUniqueReceiptNumber();
      finalReceipt = await Receipt.create({
        receiptNumber,
        hospitalId,
        patientId: admission.patientRecordId,
        doctorId: admission.doctorId,
        admissionId: admission._id,
        lineItems,
        consultationType: "IPD Admission Final Bill",
        description: `Auto-generated final bill for IPD Admission ID: ${admission.admissionId}`,
        subtotal,
        discount: 0,
        tax,
        amount,
        paidAmount,
        dueAmount,
        pdfUrl: "temp",
        createdBy: req.user._id,
      });

      // Generate Receipt PDF
      const receiptPdfBuffer = await generateReceiptPdfBuffer({
        receipt: finalReceipt,
        patient,
        doctor,
        hospital,
        hospitalLogoBuffer: logoBuffer,
        patientUserId: summary.appointmentId?.patientUserId || null,
      });

      const s3ReceiptKey = `receipts/${hospitalId}/${admission.patientRecordId}/${new Date().getFullYear()}/${String(new Date().getMonth() + 1).padStart(2, "0")}/${receiptNumber}.pdf`;
      const s3Client = getS3Client();
      const bucketName = getBucketName();

      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: s3ReceiptKey,
          Body: receiptPdfBuffer,
          ContentType: "application/pdf",
          ContentDisposition: `inline; filename="receipt-${receiptNumber}.pdf"`,
        })
      );

      // ── Storage tracking (fire-and-forget) ────────────────────────────────────
      void trackUpload({
        hospitalId,
        bucket: bucketName,
        s3Key: s3ReceiptKey,
        originalName: `receipt-${receiptNumber}.pdf`,
        fileName: `receipt-${receiptNumber}.pdf`,
        module: STORAGE_MODULES.RECEIPT,
        mimeType: "application/pdf",
        fileSizeBytes: receiptPdfBuffer.length,
        uploadedBy: req.user?._id,
        uploadedByModel: "User",
      });

      finalReceipt.pdfUrl = s3ReceiptKey;
      await finalReceipt.save();

      await recordActivity({
        action: "RECEIPT_CREATED",
        entity: "Receipt",
        entityId: finalReceipt._id,
        user: req.user,
        description: `Final admission receipt ${receiptNumber} generated automatically at discharge for ${summary.patientName}`,
        ip: req.ip,
      });
    } else {
      // Update existing receipt
      finalReceipt.lineItems = lineItems;
      finalReceipt.subtotal = subtotal;
      finalReceipt.tax = tax;
      finalReceipt.amount = amount;
      finalReceipt.paidAmount = paidAmount;
      finalReceipt.dueAmount = dueAmount;

      const receiptPdfBuffer = await generateReceiptPdfBuffer({
        receipt: finalReceipt,
        patient,
        doctor,
        hospital,
        hospitalLogoBuffer: logoBuffer,
        patientUserId: summary.appointmentId?.patientUserId || null,
      });

      const s3ReceiptKey = finalReceipt.pdfUrl;
      const s3Client = getS3Client();
      const bucketName = getBucketName();

      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: s3ReceiptKey,
          Body: receiptPdfBuffer,
          ContentType: "application/pdf",
          ContentDisposition: `inline; filename="receipt-${finalReceipt.receiptNumber}.pdf"`,
        })
      );

      // ── Storage tracking (fire-and-forget) ────────────────────────────────────
      void trackUpload({
        hospitalId,
        bucket: bucketName,
        s3Key: s3ReceiptKey,
        originalName: `receipt-${finalReceipt.receiptNumber}.pdf`,
        fileName: `receipt-${finalReceipt.receiptNumber}.pdf`,
        module: STORAGE_MODULES.RECEIPT,
        mimeType: "application/pdf",
        fileSizeBytes: receiptPdfBuffer.length,
        uploadedBy: req.user?._id,
        uploadedByModel: "User",
      });

      await finalReceipt.save();

      await recordActivity({
        action: "RECEIPT_UPDATED",
        entity: "Receipt",
        entityId: finalReceipt._id,
        user: req.user,
        description: `Final admission receipt ${finalReceipt.receiptNumber} updated at discharge summary modification for ${summary.patientName}`,
        ip: req.ip,
      });
    }

    // ── Separate Consultant Fee Receipt ───────────────────────────────────────
    // The doctor's consultation fee is always kept as its own receipt,
    // completely separate from the IPD treatment bill.
    if (consultationFee > 0) {
      const existingConsultReceipt = await Receipt.findOne({
        admissionId: admission._id,
        consultationType: "Consultant Fee",
      });

      if (!existingConsultReceipt) {
        // Generate a unique receipt number for consultant fee
        const generateConsultReceiptNumber = async () => {
          const currentYear = new Date().getFullYear();
          const yearPrefix = `RCP-${currentYear}-`;
          const latestReceipt = await Receipt.findOne({
            receiptNumber: new RegExp(`^${yearPrefix}`),
          })
            .sort({ receiptNumber: -1 })
            .lean();
          let nextSequence = 1;
          if (latestReceipt) {
            const lastNum = parseInt(latestReceipt.receiptNumber.replace(yearPrefix, ""), 10);
            if (!isNaN(lastNum)) nextSequence = lastNum + 1;
          }
          return `${yearPrefix}${String(nextSequence).padStart(6, "0")}`;
        };

        const consultReceiptNumber = await generateConsultReceiptNumber();
        const consultReceipt = await Receipt.create({
          receiptNumber: consultReceiptNumber,
          hospitalId,
          patientId: admission.patientRecordId,
          doctorId: admission.doctorId,
          admissionId: admission._id,
          consultationType: "Consultant Fee",
          description: `Consultant fee for Dr. ${admission.doctorName} \u2014 Admission ID: ${admission.admissionId}`,
          lineItems: [
            { description: `Consultant Fee \u2014 Dr. ${admission.doctorName}`, amount: consultationFee },
          ],
          subtotal: consultationFee,
          discount: 0,
          tax: 0,
          amount: consultationFee,
          paidAmount: consultationFee,
          dueAmount: 0,
          pdfUrl: "temp",
          createdBy: req.user._id,
        });

        // Generate Consultant Fee Receipt PDF
        const consultPdfBuffer = await generateReceiptPdfBuffer({
          receipt: consultReceipt,
          patient,
          doctor,
          hospital,
          hospitalLogoBuffer: logoBuffer,
          patientUserId: summary.appointmentId?.patientUserId || null,
        });

        const s3ConsultKey = `receipts/${hospitalId}/${admission.patientRecordId}/${new Date().getFullYear()}/${String(new Date().getMonth() + 1).padStart(2, "0")}/${consultReceiptNumber}-consultant.pdf`;
        const s3Client = getS3Client();
        const bucketName = getBucketName();

        await s3Client.send(
          new PutObjectCommand({
            Bucket: bucketName,
            Key: s3ConsultKey,
            Body: consultPdfBuffer,
            ContentType: "application/pdf",
            ContentDisposition: `inline; filename="receipt-${consultReceiptNumber}.pdf"`,
          })
        );

        void trackUpload({
          hospitalId,
          bucket: bucketName,
          s3Key: s3ConsultKey,
          originalName: `receipt-${consultReceiptNumber}-consultant.pdf`,
          fileName: `receipt-${consultReceiptNumber}-consultant.pdf`,
          module: STORAGE_MODULES.RECEIPT,
          mimeType: "application/pdf",
          fileSizeBytes: consultPdfBuffer.length,
          uploadedBy: req.user?._id,
          uploadedByModel: "User",
        });

        consultReceipt.pdfUrl = s3ConsultKey;
        await consultReceipt.save();

        await recordActivity({
          action: "RECEIPT_CREATED",
          entity: "Receipt",
          entityId: consultReceipt._id,
          user: req.user,
          description: `Consultant fee receipt ${consultReceiptNumber} generated at discharge for Dr. ${admission.doctorName}`,
          ip: req.ip,
        });
      }
    }

    // Generate Discharge Summary PDF Buffer including treatments list
    const pdfBuffer = await generateDischargeSummaryPdfBuffer({
      summary,
      hospitalLogoBuffer: logoBuffer,
      treatments,
      consultationFee,
    });

    const fileName = `${summary.patientName.replace(/\s+/g, "_")}_discharge_summary_${dischargeId}.pdf`;

    // Upload to AWS S3
    const uploadResult = await uploadDischargeSummaryObject({
      hospitalId: getIdString(hospitalId),
      patientOwnerId: getIdString(patient?._id || summary.patientName),
      dischargeSummaryId: dischargeId,
      body: pdfBuffer,
      fileName,
    });

    summary.pdfUrl = uploadResult.key; // Store the key or resolve presigned on fetch
    summary.s3Key = uploadResult.key;

    // Log Activity
    await recordActivity({
      action: "DISCHARGE_SUMMARY_FINALIZED",
      entity: "DischargeSummary",
      entityId: summary._id,
      user: req.user,
      description: `Discharge summary finalized for ${summary.patientName}. ID: ${dischargeId}`,
      ip: req.ip,
    });

    // Find linked PatientUser for notifications
    let patientUser = null;
    const contactFilters = [];
    if (summary.patientPhone) contactFilters.push({ phone: summary.patientPhone.trim() });
    if (summary.patientEmail) contactFilters.push({ email: summary.patientEmail.trim().toLowerCase() });

    if (contactFilters.length) {
      patientUser = await PatientUser.findOne({ $or: contactFilters }).select("_id fcmToken");
    }

    // Real-time Socket.IO Broadcast
    if (patientUser) {
      emitToPatient(getIdString(patientUser._id), "patient_discharged", {
        admissionId: admission.admissionId,
        dischargeId,
        status: "Discharged",
        hospitalName: hospital.name,
      });
    }
    emitToHospital(getIdString(hospitalId), "patient_discharged", {
      admissionId: admission._id,
      dischargeId: summary._id,
      status: "Discharged",
    });

    // Send Push Notification
    if (patientUser?.fcmToken) {
      try {
        await sendPushNotification(patientUser.fcmToken, {
          title: "Patient Discharged",
          body: `You have been successfully discharged from ${hospital.name}. Please review your discharge summary and follow-up instructions.`,
          data: { type: "discharge", admissionId: String(admission._id) },
        });

        await sendPushNotification(patientUser.fcmToken, {
          title: "Discharge Summary Ready",
          body: "Your discharge summary has been generated and is available in the MedKwik app.",
          data: { type: "discharge_summary", dischargeId: String(summary._id) },
        });
      } catch (pushErr) {
        console.error("[Discharge] Failed to send discharge push notifications:", pushErr);
      }
    }
  }

  await summary.save();

  res.status(200).json({
    success: true,
    message: isDraft ? "Discharge summary draft saved." : "Patient discharged and summary generated.",
    data: summary,
  });
});

// ─── GET /hospital-admin/discharges ──────────────────────────────────────────
exports.getDischarges = catchAsync(async (req, res, next) => {
  const hospitalId = req.user.hospitalId;
  const { search, isDraft } = req.query;

  const filter = { hospitalId };

  if (isDraft === "all") {
    // No isDraft filter
  } else if (isDraft === "true") {
    filter.isDraft = true;
  } else {
    filter.isDraft = false; // Default to finalized summaries
  }

  if (search) {
    const queryStr = String(search).trim();
    if (mongoose.Types.ObjectId.isValid(queryStr)) {
      filter.$or = [{ _id: queryStr }, { patientId: queryStr }, { admissionId: queryStr }];
    } else {
      filter.$or = [
        { dischargeId: { $regex: queryStr, $options: "i" } },
        { patientName: { $regex: queryStr, $options: "i" } },
        { doctorName: { $regex: queryStr, $options: "i" } },
        { diagnosis: { $regex: queryStr, $options: "i" } },
      ];
    }
  }

  const summaries = await DischargeSummary.find(filter)
    .populate("patientId", "firstName lastName age gender bloodGroup phone email")
    .sort({ dischargeDate: -1 });

  res.status(200).json({
    success: true,
    total: summaries.length,
    data: summaries,
  });
});

// ─── GET /hospital-admin/discharges/:id ──────────────────────────────────────
exports.getDischargeDetails = catchAsync(async (req, res, next) => {
  const summary = await DischargeSummary.findOne({
    _id: req.params.id,
    hospitalId: req.user.hospitalId,
  }).populate("patientId", "firstName lastName age gender phone email address");

  if (!summary) {
    return next(new AppError("Discharge summary not found.", 404));
  }

  res.status(200).json({
    success: true,
    data: summary,
  });
});

// ─── GET /hospital-admin/discharges/:id/pdf ──────────────────────────────────
exports.downloadSummaryPdf = catchAsync(async (req, res, next) => {
  const summary = await DischargeSummary.findOne({
    _id: req.params.id,
    hospitalId: req.user.hospitalId,
  });

  if (!summary) {
    return next(new AppError("Discharge summary not found.", 404));
  }

  if (!summary.s3Key) {
    return next(new AppError("Discharge summary PDF is not generated yet.", 404));
  }

  const fileName = `${summary.patientName.replace(/\s+/g, "_")}_discharge_summary_${summary.dischargeId}.pdf`;

  const { url } = await createDischargeSummaryDownloadUrl({
    key: summary.s3Key,
    fileName,
  });

  summary.auditLogs.push({
    action: "DOWNLOADED",
    details: `Discharge summary PDF downloaded by ${req.user.name} (${req.user.role})`,
    date: new Date(),
    performedBy: req.user._id,
    performedByName: req.user.name,
  });
  await summary.save();

  res.status(200).json({
    success: true,
    data: {
      url,
    },
  });
});

// ─── GET /patient/discharges ─────────────────────────────────────────────────
exports.getPatientDischarges = catchAsync(async (req, res, next) => {
  const patientEmail = req.user.email;
  const patientPhone = req.user.phone;

  const contactFilters = [];
  if (patientEmail) contactFilters.push({ patientEmail: patientEmail.trim().toLowerCase() });
  if (patientPhone) contactFilters.push({ patientPhone: patientPhone.trim() });

  if (!contactFilters.length) {
    return res.status(200).json({ success: true, data: [] });
  }

  const summaries = await DischargeSummary.find({ $or: contactFilters, isDraft: false })
    .populate("hospitalId", "name address phone email")
    .sort({ dischargeDate: -1 });

  const formatted = await Promise.all(
    summaries.map(async (sum) => {
      // Generate pre-signed URL for the patient PWA
      let url = "";
      if (sum.s3Key) {
        const fileName = `${sum.patientName.replace(/\s+/g, "_")}_discharge_summary_${sum.dischargeId}.pdf`;
        const resUrl = await createDischargeSummaryDownloadUrl({
          key: sum.s3Key,
          fileName,
        }).catch(() => null);
        url = resUrl?.url || "";
      }

      return {
        _id: sum._id,
        dischargeId: sum.dischargeId,
        admissionId: sum.admissionId,
        patientName: sum.patientName,
        doctorName: sum.doctorName,
        hospitalName: sum.hospitalId?.name || sum.hospitalName || "Partner Hospital",
        dischargeDate: sum.dischargeDate,
        admissionDate: sum.admissionDate,
        diagnosis: sum.diagnosis,
        historyAndClinicalSummary: sum.historyAndClinicalSummary,
        treatmentGiven: sum.treatmentGiven,
        investigations: sum.investigations,
        surgeryProcedureName: sum.surgeryProcedureName,
        surgeryDate: sum.surgeryDate,
        surgeonName: sum.surgeonName,
        anesthesiologistName: sum.anesthesiologistName,
        surgicalNotes: sum.surgicalNotes,
        conditionOnDischarge: sum.conditionOnDischarge,
        hospitalCourseSummary: sum.hospitalCourseSummary,
        medications: sum.medications || [],
        followUpDate: sum.followUpDate,
        followUpInstructions: sum.followUpInstructions,
        pdfUrl: url,
      };
    })
  );

  res.status(200).json({
    success: true,
    data: formatted,
  });
});
