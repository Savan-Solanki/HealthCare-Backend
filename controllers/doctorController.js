const Appointment = require("../models/Appointment");
const Doctor = require("../models/Doctor");
const Hospital = require("../models/Hospital");
const Patient = require("../models/Patient");
const Prescription = require("../models/Prescription");
const PrescriptionTemplate = require("../models/PrescriptionTemplate");
const PatientUser = require("../models/PatientUser");
const DoctorMedicine = require("../models/DoctorMedicine");
const AppError = require("../utils/AppError");
const {
  createPatientAppointmentConfirmationNotification,
  createPatientAppointmentStatusNotification,
  deleteAppointmentNotifications,
} = require("../utils/appointmentNotifications");
const {
  buildPrescriptionObjectKey,
  createPrescriptionDownloadUrl,
  uploadPrescriptionObject,
} = require("../utils/prescriptionStorage");
const fs = require("fs");

const { generateDoctorPrescriptionPdfBuffer } = require("../utils/prescriptionPdf");
const {
  getBrandingLogoKey,
  getLocalBrandingLogoPath,
  getMediaObjectBuffer,
  resolveStoredMediaDocument,
} = require("../utils/mediaStorage");
const { sendPushNotification } = require("../utils/pushNotifications");
const catchAsync = require("../utils/catchAsync");

const monthLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const normalizeName = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^dr\.?\s+/i, "");

const buildPatientName = (patient) =>
  [patient?.firstName, patient?.lastName].filter(Boolean).join(" ").trim();

const buildHospitalAddress = (hospital) =>
  [hospital?.address, hospital?.city, hospital?.state].filter(Boolean).join(", ");

const getIdValue = (value) => {
  if (!value) return value;
  if (typeof value === "object" && value._id) return value._id;
  return value;
};

const getIdString = (value) => {
  const id = getIdValue(value);
  if (!id) return "";
  if (typeof id.toHexString === "function") return id.toHexString();
  return String(id);
};

const normalizeTimeValue = (value) => {
  const time = String(value || "").trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : "";
};

const cleanMedicineSchedule = (schedule = {}) => ({
  morning: Boolean(schedule.morning),
  afternoon: Boolean(schedule.afternoon),
  night: Boolean(schedule.night),
  morningTime: normalizeTimeValue(schedule.morningTime),
  afternoonTime: normalizeTimeValue(schedule.afternoonTime),
  nightTime: normalizeTimeValue(schedule.nightTime),
});

const sanitizeFileName = (value, fallback = "prescription") => {
  const clean = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return clean || fallback;
};

const buildPrescriptionFileName = (prescription) =>
  `${sanitizeFileName(prescription.patientName)}-${sanitizeFileName(prescription._id)}.pdf`;

const findPatientUserForPatientRecord = async (patient) => {
  if (!patient) return null;

  const contactFilters = [];
  if (patient.email) contactFilters.push({ email: String(patient.email).trim().toLowerCase() });
  if (patient.phone) {
    const val = String(patient.phone).trim();
    contactFilters.push({ phone: val });
    const cleaned = val.replace(/\D/g, "");
    if (cleaned.length === 10) {
      contactFilters.push({ phone: cleaned }, { phone: `+91${cleaned}` }, { phone: `91${cleaned}` });
    } else if (cleaned.length === 12 && cleaned.startsWith("91")) {
      const ten = cleaned.slice(2);
      contactFilters.push({ phone: ten }, { phone: `+91${ten}` }, { phone: cleaned });
    }
  }

  if (!contactFilters.length) return null;

  // Use unique set of queries to avoid MongoDB overhead
  const uniqueFilters = [];
  const seen = new Set();
  for (const filter of contactFilters) {
    const key = filter.email ? `email:${filter.email}` : `phone:${filter.phone}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueFilters.push(filter);
    }
  }

  return PatientUser.findOne({ $or: uniqueFilters }).select("_id name fcmToken").lean();
};

const getDoctorContext = async (req) => {
  if (req.user.role !== "Doctor") {
    throw new AppError("You do not have permission to access doctor resources.", 403);
  }

  if (!req.user.hospitalId) {
    throw new AppError("Doctor account is not assigned to a hospital.", 403);
  }

  const hospitalId = getIdValue(req.user.hospitalId);

  const doctor = await Doctor.findOne({
    hospitalId,
    $or: [{ userId: req.user._id }, { email: req.user.email }],
  });

  const fullName = doctor
    ? [doctor.firstName, doctor.lastName].filter(Boolean).join(" ").trim()
    : req.user.name;

  return {
    hospitalId,
    doctor,
    fullName,
    normalizedName: normalizeName(fullName),
  };
};

const getDoctorAppointments = async ({ hospitalId, normalizedName }) => {
  const allAppointments = await Appointment.find({ hospitalId })
    .populate("patientRecordId")
    .sort({
      appointmentDate: -1,
      appointmentTime: 1,
    });

  return allAppointments.filter(
    (appointment) => normalizeName(appointment.doctorName) === normalizedName
  );
};

exports.getDashboard = catchAsync(async (req, res) => {
  const { hospitalId, doctor, fullName, normalizedName } = await getDoctorContext(req);

  const hospital = await Hospital.findById(hospitalId).select("name");
  const doctorAppointments = await getDoctorAppointments({ hospitalId, normalizedName });

  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const todayAppointments = doctorAppointments.filter((a) => {
    const d = new Date(a.appointmentDate);
    return d >= startOfToday && d <= endOfToday;
  });

  const monthAppointments = doctorAppointments.filter((a) => {
    const d = new Date(a.appointmentDate);
    return d >= startOfMonth && d < startOfNextMonth;
  });

  const completedToday = todayAppointments.filter((a) => a.status === "Completed").length;
  const pendingToday = todayAppointments.filter(
    (a) => a.status === "Scheduled" || a.status === "Confirmed"
  ).length;

  const monthRevenue = monthAppointments
    .filter((a) => a.paymentStatus === "Paid")
    .reduce((sum, a) => sum + (a.consultationFee || 0), 0);

  const upcomingAppointments = doctorAppointments
    .filter((a) => {
      const d = new Date(a.appointmentDate);
      return d >= startOfToday && (a.status === "Scheduled" || a.status === "Confirmed");
    })
    .slice(0, 5)
    .map((a) => ({
      _id: a._id,
      patientName: a.patientName,
      appointmentDate: a.appointmentDate,
      appointmentTime: a.appointmentTime,
      status: a.status,
      consultationFee: a.consultationFee,
    }));

  const monthAnchors = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - (5 - index), 1);
    return {
      key: `${date.getFullYear()}-${date.getMonth() + 1}`,
      label: monthLabels[date.getMonth()],
      month: date.getMonth() + 1,
      year: date.getFullYear(),
    };
  });

  const appointmentTrend = monthAnchors.map(({ key, label, month, year }) => {
    const count = doctorAppointments.filter((a) => {
      const d = new Date(a.appointmentDate);
      return d.getMonth() + 1 === month && d.getFullYear() === year;
    }).length;
    return { month: label, appointments: count };
  });

  const weeklyData = weekdayLabels.map((day, idx) => {
    const startOfDay = new Date(now);
    startOfDay.setDate(now.getDate() - now.getDay() + idx);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay);
    endOfDay.setHours(23, 59, 59, 999);
    const count = doctorAppointments.filter((a) => {
      const d = new Date(a.appointmentDate);
      return d >= startOfDay && d <= endOfDay;
    }).length;
    return { day, appointments: count };
  });

  const statusBreakdown = ["Scheduled", "Confirmed", "Completed", "Cancelled"].map((status) => ({
    status,
    count: doctorAppointments.filter((a) => a.status === status).length,
  }));

  const totalPatients = await Patient.countDocuments({ hospitalId });
  const prescriptions = await Prescription.find({
    hospitalId,
    doctorUserId: req.user._id,
  })
    .sort({ prescriptionDate: -1 })
    .limit(5)
    .lean();

  res.status(200).json({
    success: true,
    data: {
      doctorName: fullName,
      hospitalName: hospital?.name || "Hospital",
      doctorProfile: {
        name: fullName || req.user.name || "Doctor",
        email: req.user.email || "",
        hospitalName: hospital?.name || "Hospital",
        specialization: doctor?.specialization || "General Practice",
        department: doctor?.department || "General Medicine",
        qualification: doctor?.qualification || "",
        availableTime: doctor?.availableTime || "Schedule not updated",
        consultationFee: doctor?.consultationFee || 0,
        registrationNumber: doctor?.registrationNumber || "",
      },
      stats: {
        totalAppointments: doctorAppointments.length,
        todayAppointments: todayAppointments.length,
        completedToday,
        pendingToday,
        monthRevenue,
        totalPatients,
        monthAppointments: monthAppointments.length,
        // Aliases matching frontend field names
        appointmentsToday: todayAppointments.length,
        completedAppointments: completedToday,
        confirmedAppointments: doctorAppointments.filter(a => a.status === "Confirmed").length,
        pendingReviews: pendingToday,
        completionRate: todayAppointments.length > 0
          ? Math.round((completedToday / todayAppointments.length) * 100)
          : 0,
        paidRevenue: monthRevenue,
      },
      upcomingAppointments,
      recentPrescriptions: prescriptions,
      monthlyVisits: appointmentTrend.map(d => ({ month: d.month, visits: d.appointments })),
      weeklySchedule: weeklyData,
      charts: {
        appointmentTrend,
        weeklyData,
        statusBreakdown,
      },
    },
  });
});

exports.getPatients = catchAsync(async (req, res) => {
  const { hospitalId } = await getDoctorContext(req);
  const search = String(req.query.search || "").trim().toLowerCase();
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);

  const filter = { hospitalId };
  if (search) {
    const mongoose = require("mongoose");
    const cleanSearch = search.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    if (mongoose.Types.ObjectId.isValid(search)) {
      filter.$or = [{ _id: search }];
    } else {
      filter.$or = [
        { firstName: { $regex: search, $options: "i" } },
        { lastName: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
      if (cleanSearch && /^[0-9a-f]+$/.test(cleanSearch)) {
        filter.$or.push({
          $expr: {
            $regexMatch: {
              input: { $toString: { $ifNull: ["$_id", ""] } },
              regex: `${cleanSearch}$`,
              options: "i"
            }
          }
        });
      }
    }
  }

  const patients = await Patient.find(filter)
    .select("firstName lastName age gender phone email bloodGroup status _id")
    .limit(limit)
    .lean();

  res.status(200).json({
    success: true,
    total: patients.length,
    data: patients.map((p) => ({
      _id: p._id,
      name: buildPatientName(p),
      patientName: buildPatientName(p),
      firstName: p.firstName,
      lastName: p.lastName,
      age: p.age,
      gender: p.gender,
      phone: p.phone,
      email: p.email,
      bloodGroup: p.bloodGroup,
      status: p.status,
    })),
  });
});

exports.getPatientDetails = catchAsync(async (req, res, next) => {
  const { hospitalId, doctor } = await getDoctorContext(req);

  const patient = await Patient.findOne({ _id: req.params.id, hospitalId }).lean();
  if (!patient) {
    return next(new AppError("Patient not found.", 404));
  }

  const prescriptions = await Prescription.find({
    hospitalId,
    patientId: patient._id,
  })
    .sort({ prescriptionDate: -1 })
    .limit(10)
    .lean();

  const appointments = await Appointment.find({
    hospitalId,
    patientRecordId: patient._id,
    doctorId: doctor?._id,
  }).sort({ appointmentDate: -1 }).lean();

  const totalVisits = appointments.length;
  const completedVisits = appointments.filter(a => a.status === "Completed").length;

  const now = new Date();
  const upcomingAppointments = appointments
    .filter(a => (a.status === "Scheduled" || a.status === "Confirmed") && new Date(a.appointmentDate) >= now)
    .sort((a, b) => new Date(a.appointmentDate) - new Date(b.appointmentDate));

  const upcomingAppointment = upcomingAppointments.length > 0 ? {
    appointmentDate: upcomingAppointments[0].appointmentDate,
    appointmentTime: upcomingAppointments[0].appointmentTime || "--:--",
    status: upcomingAppointments[0].status,
  } : null;

  const careSummary = {
    doctorName: doctor ? `Dr. ${doctor.firstName} ${doctor.lastName}` : "N/A",
    specialization: doctor?.specialization || "N/A",
    department: doctor?.department || "General",
    totalVisits,
    completedVisits,
    upcomingAppointment,
  };

  const recentAppointments = appointments.slice(0, 10).map(a => ({
    _id: a._id,
    appointmentDate: a.appointmentDate,
    appointmentTime: a.appointmentTime || "--:--",
    department: a.department || "General",
    status: a.status,
    paymentStatus: a.paymentStatus,
    consultationFee: a.consultationFee,
  }));

  res.status(200).json({
    success: true,
    data: {
      _id: patient._id,
      name: buildPatientName(patient),
      patientName: buildPatientName(patient),
      firstName: patient.firstName,
      lastName: patient.lastName,
      age: patient.age,
      gender: patient.gender,
      phone: patient.phone,
      email: patient.email,
      bloodGroup: patient.bloodGroup,
      address: patient.address,
      status: patient.status,
      careSummary,
      recentAppointments,
      prescriptions,
      patient: {
        _id: patient._id,
        patientName: buildPatientName(patient),
        name: buildPatientName(patient),
        firstName: patient.firstName,
        lastName: patient.lastName,
        age: patient.age,
        gender: patient.gender,
        phone: patient.phone,
        email: patient.email,
        bloodGroup: patient.bloodGroup,
        address: patient.address,
        status: patient.status,
      },
    },
  });
});

exports.getAppointments = catchAsync(async (req, res) => {
  const { hospitalId, normalizedName, doctor } = await getDoctorContext(req);
  const search = String(req.query.search || "").trim().toLowerCase();

  const doctorAppointments = await getDoctorAppointments({ hospitalId, normalizedName });

  const buildPatientCode = (value) => {
    const clean = String(value || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    return `MW-${(clean.slice(-6) || "000000").padStart(6, "0")}`;
  };

  const filteredAppointments = (search
    ? doctorAppointments.filter((appointment) => {
        const cleanSearch = search.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
        const targetId = appointment.patientUserId || appointment.patientRecordId?._id;
        const pCode = targetId ? buildPatientCode(targetId).toLowerCase() : "";
        return (
          String(appointment.patientName || "").toLowerCase().includes(search) ||
          String(appointment.patientEmail || "").toLowerCase().includes(search) ||
          String(appointment.patientPhone || "").toLowerCase().includes(search) ||
          String(appointment.patientRecordId?._id || "").toLowerCase().includes(search) ||
          pCode.includes(cleanSearch) ||
          String(appointment.patientUserId || "").toLowerCase().includes(search) ||
          String(appointment._id || "").toLowerCase().includes(search) ||
          String(appointment.department || "").toLowerCase().includes(search) ||
          String(appointment.appointmentTime || "").toLowerCase().includes(search)
        );
      })
    : doctorAppointments
  ).map((appointment) => ({
    _id: appointment._id,
    patientName: appointment.patientName,
    doctorName: appointment.doctorName,
    department: appointment.department || doctor?.department || "General",
    appointmentDate: appointment.appointmentDate,
    appointmentTime: appointment.appointmentTime || "--:--",
    status: appointment.status,
    consultationFee: appointment.consultationFee || 0,
    paymentStatus: appointment.paymentStatus,
    paymentMethod: appointment.paymentMethod,
    createdAt: appointment.createdAt,
    patientEmail: appointment.patientEmail,
    patientPhone: appointment.patientPhone,
    patientRecordId: appointment.patientRecordId,
    patientUserId: appointment.patientUserId,
  }));

  res.status(200).json({
    success: true,
    total: filteredAppointments.length,
    data: filteredAppointments,
  });
});

exports.updateAppointmentStatus = catchAsync(async (req, res, next) => {
  const { hospitalId, normalizedName } = await getDoctorContext(req);
  const { status } = req.body;
  const allowedStatuses = ["Scheduled", "Confirmed", "Completed", "Cancelled"];

  if (!allowedStatuses.includes(status)) {
    return next(new AppError("Invalid appointment status.", 400));
  }

  const appointment = await Appointment.findOne({
    _id: req.params.id,
    hospitalId,
  });

  if (!appointment) {
    return next(new AppError("Appointment not found.", 404));
  }

  if (normalizeName(appointment.doctorName) !== normalizedName) {
    return next(new AppError("You do not have permission to update this appointment.", 403));
  }

  const oldStatus = appointment.status;
  appointment.status = status;
  await appointment.save();
  await deleteAppointmentNotifications(appointment._id);

  if (status !== oldStatus && appointment.patientUserId) {
    await createPatientAppointmentStatusNotification(appointment, status);
  }

  res.status(200).json({
    success: true,
    message: "Appointment status updated successfully.",
    data: appointment,
  });
});

exports.getHospitalProfile = catchAsync(async (req, res, next) => {
  const { hospitalId } = await getDoctorContext(req);

  const hospital = await Hospital.findById(hospitalId)
    .select("name address city state phone logo")
    .lean();

  if (!hospital) {
    return next(new AppError("Assigned hospital was not found.", 404));
  }

  const logoUrl = await resolveStoredMediaDocument(hospital.logo);

  res.status(200).json({
    success: true,
    data: {
      id: String(hospital._id),
      name: hospital.name,
      address: hospital.address,
      city: hospital.city,
      state: hospital.state,
      phone: hospital.phone,
      logoUrl,
      hasLogo: Boolean(hospital.logo?.key),
    },
  });
});

exports.getPrescriptions = catchAsync(async (req, res) => {
  const { hospitalId } = await getDoctorContext(req);
  const patientId = req.query.patientId;

  const filter = {
    hospitalId,
    doctorUserId: req.user._id,
  };

  if (patientId) {
    filter.patientId = patientId;
  }

  const prescriptions = await Prescription.find(filter)
    .sort({ prescriptionDate: -1, createdAt: -1 })
    .limit(patientId ? 20 : 50);

  res.status(200).json({
    success: true,
    total: prescriptions.length,
    data: prescriptions,
  });
});

exports.createPrescription = catchAsync(async (req, res, next) => {
  const { hospitalId, doctor, fullName } = await getDoctorContext(req);
  const {
    patientId,
    patientName,
    diagnosis,
    prescriptionDate,
    followUpDate,
    instruction,
    doctorNotes,
    medicines,
    includemedikwikLogo,
  } = req.body;

  if (!patientName?.trim()) {
    return next(new AppError("Patient name is required.", 400));
  }

  if (!diagnosis?.trim()) {
    return next(new AppError("Diagnosis is required.", 400));
  }

  if (!prescriptionDate) {
    return next(new AppError("Prescription date is required.", 400));
  }

  if (!Array.isArray(medicines) || medicines.length === 0) {
    return next(new AppError("Add at least one medicine.", 400));
  }

  let patient = null;
  if (patientId) {
    patient = await Patient.findOne({ _id: patientId, hospitalId });
    if (!patient) {
      return next(new AppError("Selected patient not found.", 404));
    }
  }

  const cleanedMedicines = medicines
    .map((medicine) => ({
      medicineName: String(medicine.medicineName || "").trim(),
      dosage: String(medicine.dosage || "").trim(),
      frequency: String(medicine.frequency || "").trim(),
      duration: String(medicine.duration || "").trim(),
      schedule: cleanMedicineSchedule(medicine.schedule),
    }))
    .filter((medicine) => medicine.medicineName && medicine.dosage && medicine.frequency && medicine.duration);

  if (cleanedMedicines.length === 0) {
    return next(new AppError("Each medicine must include name, dosage, frequency, and duration.", 400));
  }

  const [hospital, patientUser] = await Promise.all([
    Hospital.findById(hospitalId).select("name address city state phone logo").lean(),
    findPatientUserForPatientRecord(patient),
  ]);

  if (!hospital) {
    return next(new AppError("Assigned hospital was not found.", 404));
  }

  // Generate prescription number: RX-YYYY-NNNNNN
  const currentYear = new Date().getFullYear();
  const prescriptionCount = await Prescription.countDocuments({
    hospitalId,
    createdAt: {
      $gte: new Date(`${currentYear}-01-01`),
      $lt: new Date(`${currentYear + 1}-01-01`),
    },
  });
  const rxNumber = `RX-${currentYear}-${String(prescriptionCount + 1).padStart(6, "0")}`;

  const prescription = new Prescription({
    hospitalId,
    doctorId: doctor?._id || null,
    doctorUserId: req.user._id,
    patientUserId: patientUser?._id || null,
    patientId: patient?._id || null,
    prescriptionNumber: rxNumber,
    patientName: patient ? buildPatientName(patient) : patientName.trim(),
    patientAge: patient?.age || null,
    patientGender: patient?.gender || "",
    patientMobile: patient?.phone || "",
    diagnosis: diagnosis.trim(),
    prescriptionDate,
    followUpDate: followUpDate || null,
    instruction: String(instruction || "").trim(),
    doctorNotes: String(doctorNotes || "").trim(),
    doctorName: fullName,
    doctorSpecialization: doctor?.specialization || "",
    doctorRegistrationNumber: doctor?.registrationNumber || "",
    hospitalName: hospital.name,
    hospitalAddress: buildHospitalAddress(hospital),
    includemedikwikLogo: Boolean(includemedikwikLogo),
    medicines: cleanedMedicines,
  });

  const fileName = buildPrescriptionFileName(prescription);
  const hospitalIdString = getIdString(hospitalId);
  const patientIdString = getIdString(patient?._id);
  const patientUserIdString = getIdString(patientUser?._id);
  const prescriptionIdString = getIdString(prescription._id);
  const [hospitalLogoBuffer, medikwikLogoBuffer] = await Promise.all([
    hospital.logo?.key
      ? getMediaObjectBuffer(hospital.logo.key).catch(() => null)
      : Promise.resolve(null),
    prescription.includemedikwikLogo
      ? getMediaObjectBuffer(getBrandingLogoKey())
          .catch(() => {
            const localPath = getLocalBrandingLogoPath();
            return fs.existsSync(localPath) ? fs.readFileSync(localPath) : null;
          })
      : Promise.resolve(null),
  ]);

  const pdfBuffer = await generateDoctorPrescriptionPdfBuffer({
    doctorName: fullName,
    hospital,
    patient,
    prescription,
    hospitalLogoBuffer,
    medikwikLogoBuffer,
  });
  const objectKey = buildPrescriptionObjectKey({
    hospitalId: hospitalIdString,
    patientOwnerId: patientUserIdString || patientIdString || prescription.patientName,
    prescriptionId: prescriptionIdString,
    source: "doctor-generated",
    extension: "pdf",
  });

  const document = await uploadPrescriptionObject({
    key: objectKey,
    body: pdfBuffer,
    contentType: "application/pdf",
    fileName,
    metadata: {
      prescriptionId: prescriptionIdString,
      hospitalId: hospitalIdString,
      patientId: patientIdString,
      patientUserId: patientUserIdString,
      source: "doctor-generated",
    },
  });

  prescription.document = document;
  await prescription.save();

  if (patientUser?.fcmToken) {
    void sendPushNotification(patientUser.fcmToken, {
      title: "New Prescription",
      body: `Dr. ${fullName} added a prescription for you.`,
      data: {
        prescriptionId: String(prescription._id),
        url: "/dashboard/prescriptions",
      },
    });
  }

  // Auto-generate medicine reminders for the patient & emit real-time events
  try {
    const { generateRemindersFromPrescription } = require("../utils/reminderService");
    const { emitToPatient, EVENTS } = require("../utils/realtimeEvents");
    const NotificationLog = require("../models/NotificationLog");

    if (prescription.patientUserId) {
      emitToPatient(prescription.patientUserId, EVENTS.PRESCRIPTION_CREATED, {
        _id: prescription._id,
        patientName: prescription.patientName,
        diagnosis: prescription.diagnosis,
        prescriptionDate: prescription.prescriptionDate,
        followUpDate: prescription.followUpDate,
        instruction: prescription.instruction,
        medicines: prescription.medicines,
        doctorName: fullName,
        hasPdf: Boolean(prescription.document?.key),
      });

      // Create a single inbox notification for the new prescription
      try {
        const prescriptionNotif = await NotificationLog.create({
          patientUserId: prescription.patientUserId,
          title: "New Prescription",
          body: `Dr. ${fullName} has added a new prescription for you. Check your medicines and reminders.`,
          category: "prescription",
          actionUrl: "/dashboard/prescriptions",
          status: "sent",
          sentAt: new Date(),
        });
        emitToPatient(prescription.patientUserId, EVENTS.NOTIFICATION_NEW, prescriptionNotif);
      } catch (notifErr) {
        require("../utils/logger").warn(`Failed to create prescription inbox notification: ${notifErr.message}`);
      }
    }

    const createdReminders = await generateRemindersFromPrescription(prescription);

    if (createdReminders && createdReminders.length > 0 && prescription.patientUserId) {
      // Emit socket events for each new reminder
      createdReminders.forEach((reminder) => {
        emitToPatient(prescription.patientUserId, EVENTS.REMINDER_CREATED, reminder);
      });

      // Create notification log entries for each reminder so they appear in inbox
      const reminderNotifDocs = createdReminders.map((reminder) => ({
        reminderId: reminder._id,
        patientUserId: prescription.patientUserId,
        title: `Medicine Reminder: ${reminder.medicineName}`,
        body: `Dr. ${fullName} set a reminder for ${reminder.medicineName} (${reminder.dosage}). Times: ${(reminder.times || []).join(", ")}.`,
        category: "medicine_reminder",
        actionUrl: "/dashboard/reminders",
        status: "sent",
        sentAt: new Date(),
        scheduledFor: null,
      }));

      try {
        const createdNotifs = await NotificationLog.insertMany(reminderNotifDocs, { ordered: false });
        createdNotifs.forEach((notif) => {
          emitToPatient(prescription.patientUserId, EVENTS.NOTIFICATION_NEW, notif);
        });
      } catch (notifErr) {
        require("../utils/logger").warn(`Failed to create reminder inbox notifications: ${notifErr.message}`);
      }
    }
  } catch (reminderError) {
    const logger = require("../utils/logger");
    logger.warn(`Failed to generate medicine reminders for prescription ${prescription._id}: ${reminderError.message}`);
  }

  // Auto-save/update prescribed medicines in the doctor's medicine library
  try {
    for (const med of cleanedMedicines) {
      await DoctorMedicine.findOneAndUpdate(
        {
          doctorUserId: req.user._id,
          medicineName: med.medicineName,
          dosage: med.dosage,
          frequency: med.frequency,
          duration: med.duration,
        },
        {
          $setOnInsert: {
            hospitalId,
            doctorId: doctor?._id || null,
          },
          $set: {
            schedule: med.schedule,
          },
          $inc: { useCount: 1 },
        },
        { upsert: true, new: true }
      );
    }
  } catch (err) {
    require("../utils/logger").warn(`Failed to automatically save doctor medicines: ${err.message}`);
  }

  res.status(201).json({
    success: true,
    message: `Prescription created successfully for ${prescription.patientName}.`,
    data: {
      _id: prescription._id,
      prescriptionNumber: prescription.prescriptionNumber,
      patientName: prescription.patientName,
      diagnosis: prescription.diagnosis,
      prescriptionDate: prescription.prescriptionDate,
      followUpDate: prescription.followUpDate,
      instruction: prescription.instruction,
      medicines: prescription.medicines,
      doctorName: fullName,
      hasPdf: Boolean(prescription.document?.key),
    },
  });
});

exports.getPrescriptionDownload = catchAsync(async (req, res, next) => {
  const { hospitalId } = await getDoctorContext(req);

  const prescription = await Prescription.findOne({
    _id: req.params.id,
    hospitalId,
    doctorUserId: req.user._id,
  }).lean();

  if (!prescription) {
    return next(new AppError("Prescription not found.", 404));
  }

  if (!prescription.document?.key) {
    return next(new AppError("Prescription PDF is not available.", 404));
  }

  const data = await createPrescriptionDownloadUrl({
    key: prescription.document.key,
    fileName: prescription.document.fileName || buildPrescriptionFileName(prescription),
    contentType: prescription.document.contentType || "application/pdf",
  });

  res.status(200).json({
    success: true,
    data,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PRESCRIPTION TEMPLATE CONTROLLERS
// ═══════════════════════════════════════════════════════════════════════════════

exports.getPrescriptionTemplates = catchAsync(async (req, res) => {
  const { hospitalId } = await getDoctorContext(req);
  const { search, sort = "recent", limit = 50 } = req.query;

  const filter = { doctorUserId: req.user._id, hospitalId };

  if (search?.trim()) {
    filter.$text = { $search: search.trim() };
  }

  const sortMap = {
    recent: { createdAt: -1 },
    mostUsed: { useCount: -1 },
    favorites: { isFavorite: -1, useCount: -1 },
    name: { templateName: 1 },
  };

  const templates = await PrescriptionTemplate.find(filter)
    .sort(sortMap[sort] || { createdAt: -1 })
    .limit(Number(limit))
    .lean();

  res.status(200).json({
    success: true,
    data: templates,
  });
});

exports.createPrescriptionTemplate = catchAsync(async (req, res, next) => {
  const { hospitalId, doctor } = await getDoctorContext(req);
  const { templateName, diagnosis, medicines, instruction } = req.body;

  if (!templateName?.trim()) {
    return next(new AppError("Template name is required.", 400));
  }

  const cleanedMedicines = Array.isArray(medicines)
    ? medicines
        .map((m) => ({
          medicineName: String(m.medicineName || "").trim(),
          dosage: String(m.dosage || "").trim(),
          frequency: String(m.frequency || "").trim(),
          duration: String(m.duration || "").trim(),
          schedule: cleanMedicineSchedule(m.schedule),
        }))
        .filter((m) => m.medicineName && m.dosage && m.frequency && m.duration)
    : [];

  const template = await PrescriptionTemplate.create({
    hospitalId,
    doctorId: doctor?._id || null,
    doctorUserId: req.user._id,
    templateName: templateName.trim(),
    diagnosis: String(diagnosis || "").trim(),
    medicines: cleanedMedicines,
    instruction: String(instruction || "").trim(),
  });

  res.status(201).json({
    success: true,
    message: "Template created successfully.",
    data: template,
  });
});

exports.updatePrescriptionTemplate = catchAsync(async (req, res, next) => {
  const { hospitalId } = await getDoctorContext(req);

  const template = await PrescriptionTemplate.findOne({
    _id: req.params.id,
    doctorUserId: req.user._id,
    hospitalId,
  });

  if (!template) {
    return next(new AppError("Template not found.", 404));
  }

  const { templateName, diagnosis, medicines, instruction } = req.body;

  if (templateName !== undefined) template.templateName = String(templateName).trim();
  if (diagnosis !== undefined) template.diagnosis = String(diagnosis).trim();
  if (instruction !== undefined) template.instruction = String(instruction).trim();
  if (Array.isArray(medicines)) {
    template.medicines = medicines
      .map((m) => ({
        medicineName: String(m.medicineName || "").trim(),
        dosage: String(m.dosage || "").trim(),
        frequency: String(m.frequency || "").trim(),
        duration: String(m.duration || "").trim(),
        schedule: cleanMedicineSchedule(m.schedule),
      }))
      .filter((m) => m.medicineName && m.dosage && m.frequency && m.duration);
  }

  await template.save();

  res.status(200).json({
    success: true,
    message: "Template updated.",
    data: template,
  });
});

exports.deletePrescriptionTemplate = catchAsync(async (req, res, next) => {
  const { hospitalId } = await getDoctorContext(req);

  const deleted = await PrescriptionTemplate.findOneAndDelete({
    _id: req.params.id,
    doctorUserId: req.user._id,
    hospitalId,
  });

  if (!deleted) {
    return next(new AppError("Template not found.", 404));
  }

  res.status(200).json({
    success: true,
    message: "Template deleted.",
  });
});

exports.duplicatePrescriptionTemplate = catchAsync(async (req, res, next) => {
  const { hospitalId, doctor } = await getDoctorContext(req);

  const original = await PrescriptionTemplate.findOne({
    _id: req.params.id,
    doctorUserId: req.user._id,
    hospitalId,
  }).lean();

  if (!original) {
    return next(new AppError("Template not found.", 404));
  }

  const duplicate = await PrescriptionTemplate.create({
    hospitalId: original.hospitalId,
    doctorId: original.doctorId,
    doctorUserId: req.user._id,
    templateName: `${original.templateName} (Copy)`,
    diagnosis: original.diagnosis,
    medicines: original.medicines,
    instruction: original.instruction,
    isFavorite: false,
    useCount: 0,
  });

  res.status(201).json({
    success: true,
    message: "Template duplicated.",
    data: duplicate,
  });
});

exports.togglePrescriptionTemplateFavorite = catchAsync(async (req, res, next) => {
  const { hospitalId } = await getDoctorContext(req);

  const template = await PrescriptionTemplate.findOne({
    _id: req.params.id,
    doctorUserId: req.user._id,
    hospitalId,
  });

  if (!template) {
    return next(new AppError("Template not found.", 404));
  }

  template.isFavorite = !template.isFavorite;
  await template.save();

  res.status(200).json({
    success: true,
    message: template.isFavorite ? "Marked as favorite." : "Removed from favorites.",
    data: { isFavorite: template.isFavorite },
  });
});

exports.recordPrescriptionTemplateUse = catchAsync(async (req, res, next) => {
  const { hospitalId } = await getDoctorContext(req);

  const template = await PrescriptionTemplate.findOneAndUpdate(
    { _id: req.params.id, doctorUserId: req.user._id, hospitalId },
    { $inc: { useCount: 1 }, $set: { lastUsedAt: new Date() } },
    { new: true }
  );

  if (!template) {
    return next(new AppError("Template not found.", 404));
  }

  res.status(200).json({ success: true });
});

exports.getDoctorMedicines = catchAsync(async (req, res, next) => {
  const { hospitalId } = await getDoctorContext(req);
  const { search } = req.query;

  const filter = {
    doctorUserId: req.user._id,
    hospitalId,
  };

  if (search?.trim()) {
    filter.medicineName = { $regex: search.trim(), $options: "i" };
  }

  const medicines = await DoctorMedicine.find(filter)
    .sort({ useCount: -1, medicineName: 1 })
    .limit(100)
    .lean();

  res.status(200).json({
    success: true,
    data: medicines,
  });
});

exports.createDoctorMedicine = catchAsync(async (req, res, next) => {
  const { hospitalId, doctor } = await getDoctorContext(req);
  const { medicineName, dosage, frequency, duration, schedule } = req.body;

  if (!medicineName?.trim() || !dosage?.trim() || !frequency?.trim() || !duration?.trim()) {
    return next(new AppError("Medicine name, dosage, frequency, and duration are required.", 400));
  }

  const medicine = await DoctorMedicine.findOneAndUpdate(
    {
      doctorUserId: req.user._id,
      medicineName: medicineName.trim(),
      dosage: dosage.trim(),
      frequency: frequency.trim(),
      duration: duration.trim(),
    },
    {
      $setOnInsert: {
        hospitalId,
        doctorId: doctor?._id || null,
      },
      $set: {
        schedule: cleanMedicineSchedule(schedule),
      },
      $inc: { useCount: 1 },
    },
    { upsert: true, new: true }
  );

  res.status(201).json({
    success: true,
    message: "Medicine saved to library.",
    data: medicine,
  });
});

exports.deleteDoctorMedicine = catchAsync(async (req, res, next) => {
  const { hospitalId } = await getDoctorContext(req);

  const deleted = await DoctorMedicine.findOneAndDelete({
    _id: req.params.id,
    doctorUserId: req.user._id,
    hospitalId,
  });

  if (!deleted) {
    return next(new AppError("Medicine not found.", 404));
  }

  res.status(200).json({
    success: true,
    message: "Medicine deleted from library.",
  });
});

