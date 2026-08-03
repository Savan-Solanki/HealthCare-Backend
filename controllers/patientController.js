const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Appointment = require("../models/Appointment");
const Doctor = require("../models/Doctor");
const Hospital = require("../models/Hospital");
const Patient = require("../models/Patient");
const Prescription = require("../models/Prescription");
const PatientUser = require("../models/PatientUser");
const Receipt = require("../models/Receipt");
const Report = require("../models/Report");
const reportStorage = require("../utils/reportStorage");
const { GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { getS3Client, getBucketName } = require("../utils/s3Client");
const AppError = require("../utils/AppError");
const {
  createAppointmentBookingNotifications,
  createPatientAppointmentStatusNotification,
  deleteAppointmentNotifications,
} = require("../utils/appointmentNotifications");
const { EVENTS, emitToHospitalRole, emitToPatient } = require("../utils/realtimeEvents");
const {
  ALLOWED_PRESCRIPTION_MIME_TYPES,
  MAX_PRESCRIPTION_UPLOAD_BYTES,
} = require("../middleware/prescriptionUpload");
const {
  buildPrescriptionObjectKey,
  createPrescriptionDownloadUrl,
  createPrescriptionUploadUrl,
  deletePrescriptionObject,
  getPrescriptionObjectBuffer,
  uploadPrescriptionObject,
} = require("../utils/prescriptionStorage");
const { generateUploadedPrescriptionPdfBuffer } = require("../utils/prescriptionPdf");
const {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_AVATAR_UPLOAD_BYTES,
  UPLOAD_SESSION_TTL_SECONDS,
  buildAvatarObjectKey,
  createMediaUploadUrl,
  deleteMediaObject,
  extensionFromContentType,
  getMediaObjectBuffer,
  isStoredMediaKey,
  resolveMediaUrl,
} = require("../utils/mediaStorage");
const { sendPushNotification } = require("../utils/pushNotifications");
const catchAsync = require("../utils/catchAsync");
const recordActivity = require("../utils/recordActivity");
const { trackUpload, STORAGE_MODULES } = require("../utils/storageTracker");

const PRESCRIPTION_UPLOAD_SESSION_PURPOSE = "patient-prescription-upload";
const PRESCRIPTION_UPLOAD_SESSION_TTL_SECONDS = 15 * 60;
const AVATAR_UPLOAD_SESSION_PURPOSE = "patient-avatar-upload";

const monthLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const slotIntervalMinutes = 30;
const dateValuePattern = /^\d{4}-\d{2}-\d{2}$/;
const weekdayAliases = [
  ["sun", "sunday"],
  ["mon", "monday"],
  ["tue", "tues", "tuesday"],
  ["wed", "wednesday"],
  ["thu", "thur", "thurs", "thursday"],
  ["fri", "friday"],
  ["sat", "saturday"],
];
const weekdayLookup = weekdayAliases.reduce((map, aliases, index) => {
  aliases.forEach((alias) => map.set(alias, index));
  return map;
}, new Map());

const normalizeName = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const escapeRegExp = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const createExactNameRegex = (value) => {
  const normalized = String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => escapeRegExp(token))
    .join("\\s+");

  return new RegExp(`^\\s*${normalized}\\s*$`, "i");
};

const buildPatientName = (patient) =>
  [patient?.firstName, patient?.lastName].filter(Boolean).join(" ").trim();
const buildDoctorName = (doctor) =>
  [doctor?.firstName, doctor?.lastName].filter(Boolean).join(" ").trim();
const buildInputPatientName = ({ firstName, lastName }) =>
  [firstName, lastName].map((value) => String(value || "").trim()).filter(Boolean).join(" ");

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

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();

const parseDateValue = (value) => {
  if (!dateValuePattern.test(String(value || ""))) return null;

  const [year, month, day] = String(value).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
};

const formatLocalDateValue = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const isPastDateValue = (dateValue) => dateValue < formatLocalDateValue(new Date());

const isPastTimeToday = (dateValue, timeValue) => {
  if (dateValue !== formatLocalDateValue(new Date())) return false;
  const [hours, minutes] = timeValue.split(":").map(Number);
  const now = new Date();
  return hours * 60 + minutes <= now.getHours() * 60 + now.getMinutes();
};

const normalizeScheduleText = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

const parseTimeToken = ({ hour, minute = "0", meridiem }) => {
  let parsedHour = Number(hour);
  const parsedMinute = Number(minute || 0);
  const normalizedMeridiem = String(meridiem || "")
    .replace(/\./g, "")
    .toLowerCase();

  if (normalizedMeridiem === "pm" && parsedHour < 12) parsedHour += 12;
  if (normalizedMeridiem === "am" && parsedHour === 12) parsedHour = 0;

  if (
    !Number.isInteger(parsedHour) ||
    !Number.isInteger(parsedMinute) ||
    parsedHour < 0 ||
    parsedHour > 23 ||
    parsedMinute < 0 ||
    parsedMinute > 59
  ) {
    return null;
  }

  return parsedHour * 60 + parsedMinute;
};

const extractTimeValues = (segment) => {
  const matches = [];
  const timeMatcher = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/gi;
  let match = timeMatcher.exec(segment);

  while (match) {
    const minutes = parseTimeToken({
      hour: match[1],
      minute: match[2],
      meridiem: match[3],
    });

    if (minutes !== null) {
      matches.push({ minutes, meridiem: match[3] || "" });
    }

    match = timeMatcher.exec(segment);
  }

  return matches;
};

const formatMinutesAsTime = (minutes) => {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
};

const addSlotRange = (slots, start, end) => {
  if (end <= start) {
    slots.add(formatMinutesAsTime(start));
    return;
  }

  for (let minutes = start; minutes < end; minutes += slotIntervalMinutes) {
    slots.add(formatMinutesAsTime(minutes));
  }
};

const expandWeekdayRange = (start, end) => {
  const days = [];
  let current = start;

  while (true) {
    days.push(current);
    if (current === end) break;
    current = (current + 1) % 7;
    if (days.length > 7) break;
  }

  return days;
};

const getAllowedWeekdays = (availableTime) => {
  const text = normalizeScheduleText(availableTime);
  const allowed = new Set();

  if (/\bweekdays?\b/.test(text)) {
    [1, 2, 3, 4, 5].forEach((day) => allowed.add(day));
  }

  if (/\bweekends?\b/.test(text)) {
    [0, 6].forEach((day) => allowed.add(day));
  }

  const rangeMatcher = /\b(sun(?:day)?|mon(?:day)?|tue(?:s|sday|day)?|wed(?:nesday)?|thu(?:r|rs|rsday|rday|day)?|fri(?:day)?|sat(?:urday)?)\b\s*(?:-|to)\s*\b(sun(?:day)?|mon(?:day)?|tue(?:s|sday|day)?|wed(?:nesday)?|thu(?:r|rs|rsday|rday|day)?|fri(?:day)?|sat(?:urday)?)\b/g;
  let rangeMatch = rangeMatcher.exec(text);

  while (rangeMatch) {
    const start = weekdayLookup.get(rangeMatch[1]);
    const end = weekdayLookup.get(rangeMatch[2]);
    if (start !== undefined && end !== undefined) {
      expandWeekdayRange(start, end).forEach((day) => allowed.add(day));
    }
    rangeMatch = rangeMatcher.exec(text);
  }

  const dayMatcher = /\b(sun(?:day)?|mon(?:day)?|tue(?:s|sday|day)?|wed(?:nesday)?|thu(?:r|rs|rsday|rday|day)?|fri(?:day)?|sat(?:urday)?)\b/g;
  let dayMatch = dayMatcher.exec(text);

  while (dayMatch) {
    const day = weekdayLookup.get(dayMatch[1]);
    if (day !== undefined) allowed.add(day);
    dayMatch = dayMatcher.exec(text);
  }

  return allowed.size ? allowed : null;
};

const isDoctorAvailableOnDate = (availableTime, dateValue) => {
  const allowedWeekdays = getAllowedWeekdays(availableTime);
  if (!allowedWeekdays) return true;

  const date = parseDateValue(dateValue);
  if (!date) return false;

  return allowedWeekdays.has(date.getUTCDay());
};

const buildSlotsFromAvailableTime = (availableTime, dateValue) => {
  const text = normalizeScheduleText(availableTime);
  if (!text || !isDoctorAvailableOnDate(text, dateValue)) return [];

  const slots = new Set();
  const segments = text
    .split(/[,;|\n/]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const sourceSegments = segments.length ? segments : [text];
  const selectedDate = parseDateValue(dateValue);
  const selectedWeekday = selectedDate?.getUTCDay();

  sourceSegments.forEach((segment) => {
    const segmentWeekdays = getAllowedWeekdays(segment);
    if (segmentWeekdays && selectedWeekday !== undefined && !segmentWeekdays.has(selectedWeekday)) return;

    const times = extractTimeValues(segment);
    if (!times.length) return;

    const hasRange = /(?:-|to|until)/.test(segment);
    if (hasRange && times.length >= 2) {
      for (let index = 0; index < times.length - 1; index += 2) {
        addSlotRange(slots, times[index].minutes, times[index + 1].minutes);
      }
      return;
    }

    times.forEach((time) => slots.add(formatMinutesAsTime(time.minutes)));
  });

  return Array.from(slots).sort();
};

const buildDayRange = (dateValue) => ({
  $gte: new Date(`${dateValue}T00:00:00.000Z`),
  $lt: new Date(new Date(`${dateValue}T00:00:00.000Z`).getTime() + 86400000),
});

const hasValue = (value) => {
  if (value === 0) return true;
  if (Array.isArray(value)) return value.length > 0;
  if (value === null || value === undefined) return false;
  return String(value).trim().length > 0;
};

const compareAppointmentAsc = (left, right) => {
  const dateDiff = new Date(left.appointmentDate).getTime() - new Date(right.appointmentDate).getTime();
  if (dateDiff !== 0) return dateDiff;
  return String(left.appointmentTime || "").localeCompare(String(right.appointmentTime || ""));
};

const buildInitials = (name) =>
  String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "PT";

const registerHospital = (map, hospital) => {
  if (!hospital) return;

  const hospitalId = typeof hospital === "object" ? hospital._id : hospital;
  if (!hospitalId) return;

  const key = String(hospitalId);
  if (map.has(key)) return;

  map.set(key, {
    id: key,
    name: hospital.name || "Care facility",
    city: hospital.city || null,
    phone: hospital.phone || null,
    address: hospital.address || null,
  });
};

const ensureHospitalSummary = (map, hospital) => {
  if (!hospital) return null;

  const hospitalObject = typeof hospital === "object" ? hospital : null;
  const hospitalId = hospitalObject?._id || hospital;
  if (!hospitalId) return null;

  const key = String(hospitalId);
  if (!map.has(key)) {
    map.set(key, {
      id: key,
      name: hospitalObject?.name || "Care facility",
      city: hospitalObject?.city || null,
      phone: hospitalObject?.phone || null,
      address: hospitalObject?.address || null,
      doctorNames: new Set(),
      lastActivityDate: null,
      prescriptionCount: 0,
      visitCount: 0,
    });
  }

  return map.get(key);
};

const pickBestPatientRecord = (patientRecords, patientUser) => {
  if (!patientRecords.length) return null;

  const normalizedEmail = String(patientUser.email || "").trim().toLowerCase();
  const normalizedPhone = String(patientUser.phone || "").trim();

  return (
    patientRecords.find(
      (record) =>
        String(record.email || "").trim().toLowerCase() === normalizedEmail ||
        String(record.phone || "").trim() === normalizedPhone
    ) || patientRecords[0]
  );
};

const getPhoneFilters = (phone) => {
  const filters = [];
  if (!phone) return filters;
  const val = String(phone).trim();
  filters.push(val);
  const cleaned = val.replace(/\D/g, "");
  if (cleaned.length === 10) {
    filters.push(cleaned, `+91${cleaned}`, `91${cleaned}`);
  } else if (cleaned.length === 12 && cleaned.startsWith("91")) {
    const ten = cleaned.slice(2);
    filters.push(ten, `+91${ten}`, cleaned);
  }
  return Array.from(new Set(filters));
};

const getPatientRecordOwnerFilters = (patientUser) => {
  const filters = [];
  const email = normalizeEmail(patientUser.email);
  if (email) filters.push({ email });

  // NOTE: Phone is intentionally excluded here because multiple patient
  // accounts share the same phone number. Matching by phone would leak
  // data across accounts. Email + name matching is sufficient to link
  // hospital-side Patient records to the correct PatientUser account.

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

const buildPatientPrescriptionAccessFilter = async (patientUser, prescriptionId) => {
  const ownerFilters = await buildPatientPrescriptionOwnerFilters(patientUser);

  return {
    _id: prescriptionId,
    $or: ownerFilters,
  };
};

const resolveProfileAvatar = async (avatar) => resolveMediaUrl(avatar);

const pickProfileFieldValue = (recordValue, userValue) => {
  if (hasValue(recordValue)) return recordValue;
  if (hasValue(userValue)) return userValue;
  return null;
};

const resolveProfileRecordFields = (patientUser, patientRecord) => ({
  age: pickProfileFieldValue(patientRecord?.age, patientUser.age),
  gender: pickProfileFieldValue(patientRecord?.gender, patientUser.gender),
  bloodGroup: pickProfileFieldValue(patientRecord?.bloodGroup, patientUser.bloodGroup),
  emergencyContact: pickProfileFieldValue(patientRecord?.emergencyContact, patientUser.emergencyContact),
  address: pickProfileFieldValue(patientRecord?.address, patientUser.address),
  height: patientUser.height || null,
  weight: patientUser.weight || null,
  allergies: patientUser.allergies || null,
});

const getLinkedPatientRecords = async (patientUser) => {
  const normalizedEmail = String(patientUser.email || "").trim().toLowerCase();
  const nameParts = String(patientUser.name || "").trim().split(/\s+/).filter(Boolean);
  const firstName = nameParts[0] || "";
  const lastName = nameParts.slice(1).join(" ");

  const patientFilters = [];

  if (normalizedEmail) patientFilters.push({ email: normalizedEmail });
  // NOTE: Phone is intentionally excluded here because multiple patient
  // accounts share the same phone number. Matching by phone would pull
  // in Patient records belonging to OTHER accounts on the same phone,
  // leaking data across accounts.
  if (firstName && lastName) {
    patientFilters.push({
      firstName: createExactNameRegex(firstName),
      lastName: createExactNameRegex(lastName),
    });
  } else if (firstName) {
    patientFilters.push({ firstName: createExactNameRegex(firstName) });
  }

  if (!patientFilters.length) return [];

  return Patient.find({ $or: patientFilters }).sort({ updatedAt: -1, createdAt: -1 }).lean();
};

const buildProfileCompletion = (patientUser, patientRecord) => {
  const medical = resolveProfileRecordFields(patientUser, patientRecord);
  const fields = [
    { label: "Profile photo", value: patientUser.avatar },
    { label: "Email", value: patientUser.email },
    { label: "Phone", value: patientUser.phone },
    { label: "Age", value: medical.age },
    { label: "Gender", value: medical.gender },
    { label: "Blood group", value: medical.bloodGroup },
    { label: "Emergency contact", value: medical.emergencyContact },
    { label: "Address", value: medical.address },
    { label: "Height", value: medical.height },
    { label: "Weight", value: medical.weight },
  ];

  const completedFields = fields.filter((field) => hasValue(field.value)).length;

  return {
    completedFields,
    totalFields: fields.length,
    percentage: Math.round((completedFields / fields.length) * 100),
    isComplete: completedFields === fields.length,
    missingFields: fields.filter((field) => !hasValue(field.value)).map((field) => field.label),
  };
};

const buildMonthlyVisits = (appointments) => {
  const monthlyVisitMap = new Map();

  appointments.forEach((appointment) => {
    const date = new Date(appointment.appointmentDate);
    const key = `${date.getFullYear()}-${date.getMonth()}`;
    monthlyVisitMap.set(key, (monthlyVisitMap.get(key) || 0) + 1);
  });

  return Array.from({ length: 6 }, (_, index) => {
    const date = new Date();
    date.setMonth(date.getMonth() - (5 - index));
    const key = `${date.getFullYear()}-${date.getMonth()}`;

    return {
      month: monthLabels[date.getMonth()],
      visits: monthlyVisitMap.get(key) || 0,
    };
  });
};

const mapAppointment = (appointment) => ({
  id: String(appointment._id),
  doctorId: appointment.doctorId ? String(appointment.doctorId._id || appointment.doctorId) : null,
  doctorName: appointment.doctorName,
  department: appointment.department || "General care",
  patientFirstName: appointment.patientFirstName || null,
  patientLastName: appointment.patientLastName || null,
  patientEmail: appointment.patientEmail || null,
  appointmentDate: appointment.appointmentDate,
  appointmentTime: appointment.appointmentTime || null,
  status: appointment.status,
  consultationFee: appointment.consultationFee || 0,
  paymentStatus: appointment.paymentStatus,
  appointmentPurpose: appointment.appointmentPurpose || null,
  description: appointment.description || null,
  hospital: appointment.hospitalId
    ? {
        id: String(appointment.hospitalId._id || appointment.hospitalId),
        name: appointment.hospitalId.name || "Care facility",
        city: appointment.hospitalId.city || null,
        phone: appointment.hospitalId.phone || null,
        address: appointment.hospitalId.address || null,
      }
    : null,
});

const mapPrescription = (prescription) => ({
  id: String(prescription._id),
  source: prescription.source || "doctor_generated",
  diagnosis: prescription.diagnosis,
  prescriptionDate: prescription.prescriptionDate,
  followUpDate: prescription.followUpDate || null,
  instruction: prescription.instruction || "",
  doctorName: prescription.doctorName || prescription.doctorUserId?.name || null,
  hospital: prescription.hospitalId
    ? {
        id: String(prescription.hospitalId._id || prescription.hospitalId),
        name: prescription.hospitalId.name || "Care facility",
        city: prescription.hospitalId.city || null,
        phone: prescription.hospitalId.phone || null,
        address: prescription.hospitalId.address || null,
      }
    : prescription.hospitalName || prescription.hospitalAddress
      ? {
          id: "uploaded",
          name: prescription.hospitalName || "Uploaded prescription",
          city: null,
          phone: null,
          address: prescription.hospitalAddress || null,
        }
      : null,
  hasPdf: Boolean(prescription.document?.key),
  fileName: prescription.document?.fileName || null,
  fileSize: prescription.document?.size || null,
  medicines: Array.isArray(prescription.medicines)
    ? prescription.medicines.map((medicine) => ({
        name: medicine.medicineName,
        dosage: medicine.dosage,
        frequency: medicine.frequency,
        duration: medicine.duration,
        schedule: medicine.schedule || {
          morning: false,
          afternoon: false,
          night: false,
          morningTime: "",
          afternoonTime: "",
          nightTime: "",
        },
      }))
    : [],
});

const buildHospitalSummaries = (appointments, prescriptions, patientHospitals) => {
  const hospitalSummaryMap = new Map();

  patientHospitals.forEach((hospital) => {
    ensureHospitalSummary(hospitalSummaryMap, hospital);
  });

  appointments.forEach((appointment) => {
    const summary = ensureHospitalSummary(hospitalSummaryMap, appointment.hospitalId);
    if (!summary) return;

    summary.visitCount += 1;

    if (appointment.doctorName) {
      summary.doctorNames.add(normalizeName(appointment.doctorName));
    }

    if (
      !summary.lastActivityDate ||
      new Date(appointment.appointmentDate).getTime() > new Date(summary.lastActivityDate).getTime()
    ) {
      summary.lastActivityDate = appointment.appointmentDate;
    }
  });

  prescriptions.forEach((prescription) => {
    const summary = ensureHospitalSummary(hospitalSummaryMap, prescription.hospitalId);
    if (!summary) return;

    summary.prescriptionCount += 1;

    if (prescription.doctorUserId?.name) {
      summary.doctorNames.add(normalizeName(prescription.doctorUserId.name));
    }

    if (
      !summary.lastActivityDate ||
      new Date(prescription.prescriptionDate).getTime() > new Date(summary.lastActivityDate).getTime()
    ) {
      summary.lastActivityDate = prescription.prescriptionDate;
    }
  });

  return Array.from(hospitalSummaryMap.values())
    .map((summary) => ({
      id: summary.id,
      name: summary.name,
      city: summary.city,
      phone: summary.phone,
      address: summary.address,
      doctorCount: summary.doctorNames.size,
      visitCount: summary.visitCount,
      prescriptionCount: summary.prescriptionCount,
      lastActivityDate: summary.lastActivityDate,
    }))
    .sort((left, right) => {
      if (right.visitCount !== left.visitCount) return right.visitCount - left.visitCount;
      if (right.prescriptionCount !== left.prescriptionCount) {
        return right.prescriptionCount - left.prescriptionCount;
      }
      return left.name.localeCompare(right.name);
    });
};

const buildRecentActivity = (appointments, prescriptions) => {
  const appointmentActivity = appointments.slice(0, 4).map((appointment) => ({
    id: `appointment-${appointment._id}`,
    type: "appointment",
    title: `Visit with ${appointment.doctorName}`,
    subtitle: [appointment.department, appointment.hospitalId?.name].filter(Boolean).join(" / "),
    timestamp: appointment.appointmentDate,
    status: appointment.status,
  }));

  const prescriptionActivity = prescriptions.slice(0, 3).map((prescription) => ({
    id: `prescription-${prescription._id}`,
    type: "prescription",
    title: prescription.diagnosis,
    subtitle: [
      prescription.doctorUserId?.name ? `Dr. ${prescription.doctorUserId.name}` : null,
      prescription.hospitalId?.name,
      Array.isArray(prescription.medicines) && prescription.medicines.length
        ? `${prescription.medicines.length} medicine${prescription.medicines.length === 1 ? "" : "s"}`
        : null,
    ]
      .filter(Boolean)
      .join(" / "),
    timestamp: prescription.prescriptionDate,
    status: "Prescription",
  }));

  return [...appointmentActivity, ...prescriptionActivity]
    .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
    .slice(0, 6);
};

const mapBookingHospital = (hospital, doctorCount = 0) => ({
  id: String(hospital._id),
  name: hospital.name,
  city: hospital.city || null,
  state: hospital.state || null,
  address: hospital.address || null,
  phone: hospital.phone || null,
  type: hospital.type || null,
  specializations: Array.isArray(hospital.specializations) ? hospital.specializations : [],
  doctorCount,
});

const mapBookingDoctor = (doctor) => {
  const fullName = buildDoctorName(doctor);

  return {
    id: String(doctor._id),
    hospitalId: String(doctor.hospitalId),
    fullName,
    firstName: doctor.firstName,
    lastName: doctor.lastName,
    initials: buildInitials(fullName),
    specialization: doctor.specialization || null,
    department: doctor.department || null,
    qualification: doctor.qualification || null,
    experience: doctor.experience || null,
    availableTime: doctor.availableTime || null,
    consultationFee: doctor.consultationFee || 0,
  };
};

const mapBookingProfile = (patientUser) => {
  const nameParts = String(patientUser.name || "").trim().split(/\s+/).filter(Boolean);

  return {
    id: String(patientUser._id),
    name: patientUser.name,
    firstName: nameParts[0] || "",
    lastName: nameParts.slice(1).join(" "),
    email: patientUser.email,
    phone: patientUser.phone,
    initials: buildInitials(patientUser.name),
  };
};

const getDoctorAvailableSlots = async ({ hospitalId, doctor, dateValue, excludeAppointmentId = null }) => {
  const doctorId = doctor._id;
  const DoctorLeave = require("../models/DoctorLeave");
  const DoctorSlot = require("../models/DoctorSlot");

  // Check if doctor has an active leave covering the dateValue
  const leave = await DoctorLeave.findOne({
    hospitalId,
    doctorId,
    startDate: { $lte: dateValue },
    endDate: { $gte: dateValue },
    status: "Active",
  });

  if (leave && leave.leaveType !== "Half-Day Leave") {
    // Single Day, Multiple Day, and Emergency leaves render no slots
    return [];
  }

  // Find all active slots configured for this doctor on this date
  const slots = await DoctorSlot.find({
    hospitalId,
    doctorId,
    date: dateValue,
    isActive: true,
  }).sort({ slotTime: 1 });

  const availableSlots = [];
  for (const slot of slots) {
    let status = slot.status;

    // Overlay Half-Day Leave status
    if (leave && leave.leaveType === "Half-Day Leave") {
      const slotHour = parseInt(slot.slotTime.split(":")[0], 10);
      if (leave.halfDayOption === "First Half" && slotHour < 14) {
        status = "Doctor On Leave";
      } else if (leave.halfDayOption === "Second Half" && slotHour >= 14) {
        status = "Doctor On Leave";
      }
    }

    // Allow if status is Available, or if it is the currently occupied slot when rescheduling
    const isCurrentlyReschedulingThisSlot = excludeAppointmentId && String(slot.appointmentId) === String(excludeAppointmentId);
    if (status === "Available" || isCurrentlyReschedulingThisSlot) {
      if (!isPastTimeToday(dateValue, slot.slotTime)) {
        availableSlots.push(slot.slotTime);
      }
    }
  }

  return availableSlots;
};


const findOrCreateAppointmentPatientRecord = async ({
  email,
  firstName,
  hospitalId,
  lastName,
  phone,
}) => {
  const patientNameFilter = {
    firstName: createExactNameRegex(firstName),
    lastName: createExactNameRegex(lastName),
  };
  const contactFilters = [];

  if (phone) contactFilters.push({ phone });
  if (email) contactFilters.push({ email });

  const existingPatient = contactFilters.length
    ? await Patient.findOne({
        hospitalId,
        ...patientNameFilter,
        $or: contactFilters,
      })
    : null;

  if (existingPatient) return existingPatient;

  return Patient.create({
    hospitalId,
    firstName,
    lastName,
    email: email || null,
    phone: phone || null,
    status: "Active",
  });
};

exports.getBookingOptions = catchAsync(async (req, res) => {
  const hospitals = await Hospital.find({ status: "Active" })
    .select("name city state address phone type specializations")
    .sort({ name: 1 })
    .lean();

  const hospitalIds = hospitals.map((hospital) => hospital._id);
  const doctorCounts = hospitalIds.length
    ? await Doctor.aggregate([
        { $match: { hospitalId: { $in: hospitalIds } } },
        { $group: { _id: "$hospitalId", count: { $sum: 1 } } },
      ])
    : [];

  const doctorCountMap = new Map(
    doctorCounts.map((item) => [String(item._id), item.count])
  );

  res.status(200).json({
    success: true,
    data: {
      profile: mapBookingProfile(req.user),
      hospitals: hospitals.map((hospital) =>
        mapBookingHospital(hospital, doctorCountMap.get(String(hospital._id)) || 0)
      ),
    },
  });
});

exports.getBookingDoctors = catchAsync(async (req, res, next) => {
  const hospital = await Hospital.findOne({
    _id: req.params.hospitalId,
    status: "Active",
  })
    .select("_id")
    .lean();

  if (!hospital) {
    return next(new AppError("Selected hospital is not available for booking.", 404));
  }

  const doctors = await Doctor.find({ hospitalId: hospital._id })
    .select(
      "hospitalId firstName lastName specialization department qualification experience availableTime consultationFee"
    )
    .sort({ firstName: 1, lastName: 1 })
    .lean();

  res.status(200).json({
    success: true,
    total: doctors.length,
    data: doctors.map(mapBookingDoctor),
  });
});

exports.getBookingAvailability = catchAsync(async (req, res, next) => {
  const { doctorId, date, excludeAppointmentId } = req.query;

  const appointmentDate = parseDateValue(date);
  if (!appointmentDate) {
    return next(new AppError("Select a valid appointment date.", 400));
  }

  if (isPastDateValue(date)) {
    return next(new AppError("Appointment date cannot be in the past.", 400));
  }

  const doctor = await Doctor.findById(doctorId)
    .select("hospitalId firstName lastName availableTime")
    .lean();

  if (!doctor) {
    return next(new AppError("Selected doctor was not found.", 404));
  }

  const hospital = await Hospital.findOne({
    _id: doctor.hospitalId,
    status: "Active",
  })
    .select("_id")
    .lean();

  if (!hospital) {
    return next(new AppError("Selected hospital is not available for booking.", 404));
  }

  const DoctorLeave = require("../models/DoctorLeave");
  const leave = await DoctorLeave.findOne({
    hospitalId: doctor.hospitalId,
    doctorId: doctor._id,
    startDate: { $lte: date },
    endDate: { $gte: date },
    status: "Active",
  });

  const slots = await getDoctorAvailableSlots({
    hospitalId: doctor.hospitalId,
    doctor,
    dateValue: date,
    excludeAppointmentId: excludeAppointmentId || null,
  });

  const isOnLeave = !!(leave && leave.leaveType !== "Half-Day Leave");

  res.status(200).json({
    success: true,
    data: {
      doctorId: String(doctor._id),
      date,
      slots,
      isOnLeave,
      leaveMessage: isOnLeave ? "Doctor Not Available" : null,
    },
  });
});

exports.createAppointment = catchAsync(async (req, res, next) => {
  const {
    appointmentDate,
    appointmentTime,
    description,
    doctorId,
    hospitalId,
    patientEmail,
    patientFirstName,
    patientLastName,
    purpose,
  } = req.body;

  if (!patientFirstName || !String(patientFirstName).trim()) {
    return next(new AppError("First name is required.", 400));
  }
  if (!patientLastName || !String(patientLastName).trim()) {
    return next(new AppError("Last name is required.", 400));
  }
  if (!patientEmail || !String(patientEmail).trim()) {
    return next(new AppError("Email address is required.", 400));
  }
  if (!purpose || !String(purpose).trim()) {
    return next(new AppError("Purpose of appointment is required.", 400));
  }

  const freshPatientUser = await PatientUser.findById(req.user._id);
  if (!freshPatientUser) {
    return next(new AppError("The patient user belonging to this token no longer exists.", 401));
  }

  const patientRecords = await getLinkedPatientRecords(freshPatientUser);
  const bestPatientRecord = pickBestPatientRecord(patientRecords, freshPatientUser);
  const profileCompletion = buildProfileCompletion(freshPatientUser, bestPatientRecord);

  if (!profileCompletion.isComplete) {
    return next(
      new AppError(
        `Complete your health profile before booking appointments. Missing: ${profileCompletion.missingFields.join(", ")}.`,
        403
      )
    );
  }

  const parsedAppointmentDate = parseDateValue(appointmentDate);
  if (!parsedAppointmentDate) {
    return next(new AppError("Select a valid appointment date.", 400));
  }

  if (isPastDateValue(appointmentDate) || isPastTimeToday(appointmentDate, appointmentTime)) {
    return next(new AppError("Appointment slot cannot be in the past.", 400));
  }

  const [hospital, doctor] = await Promise.all([
    Hospital.findOne({ _id: hospitalId, status: "Active" }).select("name").lean(),
    Doctor.findOne({ _id: doctorId, hospitalId })
      .select(
        "hospitalId userId firstName lastName specialization department availableTime consultationFee"
      )
      .lean(),
  ]);

  if (!hospital) {
    return next(new AppError("Selected hospital is not available for booking.", 404));
  }

  if (!doctor) {
    return next(new AppError("Selected doctor was not found at this hospital.", 404));
  }

  const DoctorSlot = require("../models/DoctorSlot");
  const { emitSlotsUpdated } = require("../utils/realtimeEvents");

  // Verify slot is still available and lock it atomically
  const updatedSlot = await DoctorSlot.findOneAndUpdate(
    {
      hospitalId,
      doctorId: doctor._id,
      date: appointmentDate,
      slotTime: appointmentTime,
      status: "Available",
      isActive: true,
    },
    {
      status: "Booked",
    },
    { new: true }
  );

  if (!updatedSlot) {
    return next(new AppError("Selected time slot is no longer available.", 409));
  }

  const firstName = String(patientFirstName || "").trim();
  const lastName = String(patientLastName || "").trim();
  const email = normalizeEmail(patientEmail);
  const patientName = buildInputPatientName({ firstName, lastName });
  const patientRecord = await findOrCreateAppointmentPatientRecord({
    email,
    firstName,
    hospitalId,
    lastName,
    phone: req.user.phone,
  });

  let appointment;
  try {
    appointment = await Appointment.create({
      hospitalId,
      patientUserId: req.user._id,
      patientRecordId: patientRecord._id,
      patientFirstName: firstName,
      patientLastName: lastName,
      patientName,
      patientEmail: email,
      patientPhone: req.user.phone,
      doctorId: doctor._id,
      doctorName: buildDoctorName(doctor),
      department: doctor.department || doctor.specialization || "General care",
      appointmentDate: parsedAppointmentDate,
      appointmentTime,
      consultationFee: doctor.consultationFee || 0,
      appointmentPurpose: String(purpose || "").trim(),
      description: String(description || "").trim() || null,
      status: "Scheduled",
      paymentStatus: "Pending",
      paymentMethod: "Cash",
    });

    updatedSlot.appointmentId = appointment._id;
    await updatedSlot.save();
  } catch (error) {
    // Revert the slot status if appointment creation fails
    await DoctorSlot.updateOne(
      { _id: updatedSlot._id },
      { status: "Available", appointmentId: null }
    );
    return next(error);
  }

  // Emit real-time slots updated event to sync other patients' booking pages instantly
  emitSlotsUpdated(hospitalId, doctor._id, appointmentDate);

  await recordActivity({
    action: "PATIENT_APPOINTMENT_BOOKED",
    entity: "Appointment",
    entityId: appointment._id,
    user: req.user,
    description: `Patient appointment booked with ${appointment.doctorName} at ${hospital.name}`,
    ip: req.ip,
    meta: {
      hospitalId: String(hospitalId),
      doctorId: String(doctorId),
      appointmentDate,
      appointmentTime,
    },
  });

  await createAppointmentBookingNotifications({
    appointment,
    doctor,
    hospital,
  });

  await createPatientAppointmentStatusNotification(appointment, "Scheduled");

  res.status(201).json({
    success: true,
    message: "Appointment booked successfully.",
    data: mapAppointment({
      ...appointment.toObject(),
      hospitalId: hospital,
    }),
  });
});

const getAppointmentHospitalId = (appointment) =>
  appointment?.hospitalId?._id || appointment?.hospitalId || null;

const buildHospitalContact = (hospital) => {
  if (!hospital) return null;

  return {
    id: String(hospital._id || hospital.id || hospital),
    name: hospital.name || "Care facility",
    city: hospital.city || null,
    phone: hospital.phone || null,
    address: hospital.address || null,
  };
};

const sendAppointmentContactResponse = (res, appointment, message) =>
  res.status(409).json({
    success: false,
    message,
    error: "AppointmentLocked",
    code: "CONTACT_HOSPITAL_REQUIRED",
    data: {
      hospital: buildHospitalContact(appointment.hospitalId),
    },
  });

const getLockedAppointmentMessage = (appointment, action) => {
  const contactAction = action === "edit" ? "change" : "cancel";
  const passiveAction = action === "edit" ? "edited" : "cancelled";

  if (appointment.status === "Confirmed") {
    return `This appointment is already confirmed. Please contact the hospital to ${contactAction} it.`;
  }

  return `Only scheduled appointments can be ${passiveAction} online. Please contact the hospital.`;
};

const findDoctorForAppointment = async (appointment) => {
  const hospitalId = getAppointmentHospitalId(appointment);
  if (!hospitalId) return null;

  if (appointment.doctorId) {
    const doctor = await Doctor.findOne({
      _id: appointment.doctorId,
      hospitalId,
    })
      .select("hospitalId userId firstName lastName specialization department availableTime consultationFee")
      .lean();

    if (doctor) return doctor;
  }

  const doctors = await Doctor.find({ hospitalId })
    .select("hospitalId userId firstName lastName specialization department availableTime consultationFee")
    .lean();

  return doctors.find((doctor) => normalizeName(buildDoctorName(doctor)) === normalizeName(appointment.doctorName)) || null;
};

const emitPatientAppointmentChange = (appointment, event) => {
  const hospitalId = getAppointmentHospitalId(appointment);
  const payload = appointment.toObject ? appointment.toObject() : appointment;

  if (appointment.patientUserId) {
    emitToPatient(appointment.patientUserId, event, payload);
  }

  if (hospitalId) {
    emitToHospitalRole(hospitalId, "Receptionist", event, payload);
    emitToHospitalRole(hospitalId, "Hospital Admin", event, payload);
    emitToHospitalRole(hospitalId, "Doctor", event, payload);
  }
};

exports.updateAppointment = catchAsync(async (req, res, next) => {
  const {
    appointmentDate,
    appointmentTime,
    description,
    patientEmail,
    patientFirstName,
    patientLastName,
    purpose,
  } = req.body;

  if (!patientFirstName || !String(patientFirstName).trim()) {
    return next(new AppError("First name is required.", 400));
  }
  if (!patientLastName || !String(patientLastName).trim()) {
    return next(new AppError("Last name is required.", 400));
  }
  if (!patientEmail || !String(patientEmail).trim()) {
    return next(new AppError("Email address is required.", 400));
  }
  if (!purpose || !String(purpose).trim()) {
    return next(new AppError("Purpose of appointment is required.", 400));
  }

  const appointment = await Appointment.findOne({
    _id: req.params.id,
    patientUserId: req.user._id,
  }).populate("hospitalId", "name city phone address");

  if (!appointment) {
    return next(new AppError("Appointment not found.", 404));
  }

  if (appointment.status !== "Scheduled") {
    return sendAppointmentContactResponse(
      res,
      appointment,
      getLockedAppointmentMessage(appointment, "edit")
    );
  }

  const parsedAppointmentDate = parseDateValue(appointmentDate);
  if (!parsedAppointmentDate) {
    return next(new AppError("Select a valid appointment date.", 400));
  }

  if (isPastDateValue(appointmentDate) || isPastTimeToday(appointmentDate, appointmentTime)) {
    return next(new AppError("Appointment slot cannot be in the past.", 400));
  }

  const doctor = await findDoctorForAppointment(appointment);
  if (!doctor) {
    return sendAppointmentContactResponse(
      res,
      appointment,
      "This appointment cannot be edited online. Please contact the hospital."
    );
  }

  const hospitalId = getAppointmentHospitalId(appointment);
  const DoctorSlot = require("../models/DoctorSlot");
  const { emitSlotsUpdated } = require("../utils/realtimeEvents");

  const oldDate = appointment.appointmentDate.toISOString().split("T")[0];
  const oldTime = appointment.appointmentTime;
  const slotChanged = oldDate !== appointmentDate || oldTime !== appointmentTime;

  let oldSlot = null;
  if (slotChanged) {
    // Revert/free up old slot
    oldSlot = await DoctorSlot.findOneAndUpdate(
      { appointmentId: appointment._id },
      { status: "Available", appointmentId: null }
    );

    // Atomically reserve new slot
    const newSlot = await DoctorSlot.findOneAndUpdate(
      {
        hospitalId,
        doctorId: doctor._id,
        date: appointmentDate,
        slotTime: appointmentTime,
        status: "Available",
        isActive: true,
      },
      {
        status: "Booked",
        appointmentId: appointment._id,
      },
      { new: true }
    );

    if (!newSlot) {
      // Revert old slot status back to booked if new slot locking fails
      if (oldSlot) {
        await DoctorSlot.updateOne({ _id: oldSlot._id }, { status: "Booked", appointmentId: appointment._id });
      }
      return next(new AppError("Selected time slot is no longer available.", 409));
    }
  }

  const firstName = String(patientFirstName || "").trim();
  const lastName = String(patientLastName || "").trim();
  const email = normalizeEmail(patientEmail);
  const patientName = buildInputPatientName({ firstName, lastName });

  appointment.doctorId = doctor._id;
  appointment.patientFirstName = firstName;
  appointment.patientLastName = lastName;
  appointment.patientName = patientName;
  appointment.patientEmail = email;
  appointment.appointmentDate = parsedAppointmentDate;
  appointment.appointmentTime = appointmentTime;
  appointment.appointmentPurpose = String(purpose || "").trim();
  appointment.description = String(description || "").trim() || null;

  await appointment.save();

  if (slotChanged) {
    emitSlotsUpdated(hospitalId, doctor._id, oldDate);
    emitSlotsUpdated(hospitalId, doctor._id, appointmentDate);
  }

  if (appointment.patientRecordId) {
    await Patient.findOneAndUpdate(
      { _id: appointment.patientRecordId, hospitalId },
      {
        firstName,
        lastName,
        email: email || null,
        phone: req.user.phone || appointment.patientPhone || null,
      },
      { runValidators: true }
    );
  }

  await recordActivity({
    action: "PATIENT_APPOINTMENT_UPDATED",
    entity: "Appointment",
    entityId: appointment._id,
    user: req.user,
    description: `Patient updated appointment with ${appointment.doctorName}`,
    ip: req.ip,
    meta: {
      appointmentDate,
      appointmentTime,
    },
  });

  await deleteAppointmentNotifications(appointment._id);
  await createAppointmentBookingNotifications({
    appointment: {
      ...appointment.toObject(),
      hospitalId,
    },
    doctor,
    emitRealtime: false,
    hospital: appointment.hospitalId,
  });
  emitPatientAppointmentChange(appointment, EVENTS.APPOINTMENT_UPDATED);

  res.status(200).json({
    success: true,
    message: "Appointment updated successfully.",
    data: mapAppointment(appointment),
  });
});

exports.cancelAppointment = catchAsync(async (req, res, next) => {
  const appointment = await Appointment.findOne({
    _id: req.params.id,
    patientUserId: req.user._id,
  }).populate("hospitalId", "name city phone address");

  if (!appointment) {
    return next(new AppError("Appointment not found.", 404));
  }

  if (appointment.status !== "Scheduled") {
    return sendAppointmentContactResponse(
      res,
      appointment,
      getLockedAppointmentMessage(appointment, "cancel")
    );
  }

  appointment.status = "Cancelled";
  await appointment.save();
  await deleteAppointmentNotifications(appointment._id);

  const DoctorSlot = require("../models/DoctorSlot");
  const { emitSlotsUpdated } = require("../utils/realtimeEvents");
  const cancelledSlot = await DoctorSlot.findOneAndUpdate(
    { appointmentId: appointment._id },
    { status: "Available", appointmentId: null },
    { new: true }
  );

  if (cancelledSlot) {
    const hospitalId = getAppointmentHospitalId(appointment);
    emitSlotsUpdated(hospitalId, appointment.doctorId, cancelledSlot.date);
  }

  await recordActivity({
    action: "PATIENT_APPOINTMENT_CANCELLED",
    entity: "Appointment",
    entityId: appointment._id,
    user: req.user,
    description: `Patient cancelled appointment with ${appointment.doctorName}`,
    ip: req.ip,
  });

  emitPatientAppointmentChange(appointment, EVENTS.APPOINTMENT_CANCELLED);

  res.status(200).json({
    success: true,
    message: "Appointment cancelled successfully.",
    data: mapAppointment(appointment),
  });
});

exports.getDashboard = catchAsync(async (req, res) => {
  const patientUser = req.user;
  const since = req.query.since;
  const normalizedEmail = String(patientUser.email || "").trim().toLowerCase();
  const patientRecords = await getLinkedPatientRecords(patientUser);

  const nameVariants = Array.from(
    new Set(
      [patientUser.name, ...patientRecords.map((record) => buildPatientName(record))]
        .filter(Boolean)
        .map((value) => String(value).trim())
    )
  );

  const nameQueries = nameVariants.map((name) => ({
    patientName: createExactNameRegex(name),
  }));
  const appointmentOrFilters = [
    { patientUserId: patientUser._id },
    ...nameQueries,
  ];

  if (normalizedEmail) {
    appointmentOrFilters.push({ patientEmail: normalizedEmail });
  }

  // NOTE: patientPhone is intentionally excluded from appointment matching
  // because multiple patient accounts share the same phone number.
  // Including phone here would show Account-1's appointments on Account-2.

  const patientRecordHospitalIds = Array.from(
    new Set(patientRecords.map((record) => record.hospitalId).filter(Boolean).map((id) => String(id)))
  );

  const prescriptionLinkedPatientRecords = patientRecords.filter((record) => {
    const recordEmail = String(record.email || "").trim().toLowerCase();

    // Only match by email — phone is shared across accounts so matching
    // by phone would leak prescriptions from other accounts.
    return normalizedEmail && recordEmail === normalizedEmail;
  });

  const prescriptionOrFilters = [
    { patientUserId: patientUser._id },
    { uploadedByPatientUserId: patientUser._id },
  ];

  if (prescriptionLinkedPatientRecords.length) {
    prescriptionOrFilters.push({
      patientId: {
        $in: prescriptionLinkedPatientRecords.map((record) => record._id),
      },
    });
  }

  const appointmentFilter = { $or: appointmentOrFilters };
  const prescriptionFilter = { $or: prescriptionOrFilters };
  if (since) {
    const sinceDate = new Date(since);
    appointmentFilter.updatedAt = { $gt: sinceDate };
    prescriptionFilter.updatedAt = { $gt: sinceDate };
  }

  const CreditTransaction = require("../models/CreditTransaction");
  const [appointments, prescriptions, patientHospitals, totalCreditsUsed, lastCreditTx] = await Promise.all([
    appointmentOrFilters.length
      ? Appointment.find(appointmentFilter)
          .select(
            "hospitalId patientName patientFirstName patientLastName patientEmail doctorId doctorName department appointmentDate appointmentTime status consultationFee paymentStatus appointmentPurpose description"
          )
          .sort({ appointmentDate: -1, appointmentTime: 1 })
          .populate("hospitalId", "name city phone address")
          .lean()
      : Promise.resolve([]),
    prescriptionOrFilters.length
      ? Prescription.find(prescriptionFilter)
          .select(
            "source hospitalId doctorUserId patientUserId uploadedByPatientUserId patientId patientName diagnosis prescriptionDate followUpDate instruction medicines doctorName hospitalName hospitalAddress document"
          )
          .sort({ prescriptionDate: -1, createdAt: -1 })
          .populate("hospitalId", "name city phone address")
          .populate("doctorUserId", "name")
          .lean()
      : Promise.resolve([]),
    patientRecordHospitalIds.length
      ? Hospital.find({ _id: { $in: patientRecordHospitalIds } })
          .select("name city phone address")
          .lean()
      : Promise.resolve([]),
    CreditTransaction.countDocuments({ userId: patientUser._id, type: "consumption" }),
    CreditTransaction.findOne({ userId: patientUser._id, type: "consumption" }).sort({ createdAt: -1 }).select("createdAt").lean(),
  ]);

  const lastCreditUsage = lastCreditTx ? lastCreditTx.createdAt : null;

  const hospitalMap = new Map();
  patientHospitals.forEach((hospital) => registerHospital(hospitalMap, hospital));
  appointments.forEach((appointment) => registerHospital(hospitalMap, appointment.hospitalId));
  prescriptions.forEach((prescription) => registerHospital(hospitalMap, prescription.hospitalId));

  const bestPatientRecord = pickBestPatientRecord(patientRecords, patientUser);
  const profileMedical = resolveProfileRecordFields(patientUser, bestPatientRecord);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const upcomingAppointments = appointments
    .filter(
      (appointment) =>
        appointment.status !== "Cancelled" &&
        appointment.status !== "Completed" &&
        new Date(appointment.appointmentDate).getTime() >= today.getTime()
    )
    .sort(compareAppointmentAsc);

  const latestPrescription = prescriptions[0] ? mapPrescription(prescriptions[0]) : null;
  const recentPrescriptions = prescriptions.slice(0, 6).map(mapPrescription);
  const hospitalSummaries = buildHospitalSummaries(appointments, prescriptions, patientHospitals);
  const profileCompletion = buildProfileCompletion(patientUser, bestPatientRecord);
  const distinctDoctors = new Set(
    [...appointments.map((appointment) => appointment.doctorName), ...prescriptions.map((prescription) => prescription.doctorUserId?.name)]
      .filter(Boolean)
      .map((value) => normalizeName(value))
  );

  const primaryHospital =
    bestPatientRecord?.hospitalId ? hospitalMap.get(String(bestPatientRecord.hospitalId)) || null : null;

  const avatarUrl = await resolveProfileAvatar(patientUser.avatar);

  res.status(200).json({
    success: true,
    data: {
      profile: {
        id: String(patientUser._id),
        name: patientUser.name,
        firstName: String(patientUser.name || "").trim().split(/\s+/)[0] || "there",
        email: patientUser.email,
        phone: patientUser.phone,
        avatar: avatarUrl,
        initials: buildInitials(patientUser.name),
        memberSince: patientUser.createdAt,
        lastLogin: patientUser.lastLogin || null,
        prescriptionCredits: patientUser.prescriptionCredits || 0,
        reportCredits: patientUser.reportCredits || 0,
        totalCreditsUsed: totalCreditsUsed || 0,
        lastCreditUsage: lastCreditUsage || null,
      },
      patientRecord: {
        age: profileMedical.age,
        gender: profileMedical.gender,
        bloodGroup: profileMedical.bloodGroup,
        emergencyContact: profileMedical.emergencyContact,
        address: profileMedical.address,
        height: profileMedical.height,
        weight: profileMedical.weight,
        allergies: profileMedical.allergies,
        primaryHospitalName: primaryHospital?.name || null,
      },
      profileCompletion,
      stats: {
        totalVisits: appointments.length,
        completedVisits: appointments.filter((appointment) => appointment.status === "Completed").length,
        upcomingVisits: upcomingAppointments.length,
        pendingPayments: appointments.filter(
          (appointment) => appointment.status !== "Cancelled" && appointment.paymentStatus === "Pending"
        ).length,
        prescriptionCount: prescriptions.length,
        activeMedicineCount: latestPrescription?.medicines.length || 0,
        hospitalCount: hospitalMap.size,
        careTeamCount: distinctDoctors.size,
      },
      nextAppointment: upcomingAppointments[0] ? mapAppointment(upcomingAppointments[0]) : null,
      upcomingAppointments: upcomingAppointments.slice(1, 4).map(mapAppointment),
      monthlyVisits: buildMonthlyVisits(appointments),
      latestPrescription,
      recentPrescriptions,
      hospitals: hospitalSummaries.slice(0, 6),
      recentActivity: buildRecentActivity(appointments, prescriptions),
    },
  });
});

exports.getPrescriptions = catchAsync(async (req, res) => {
  const patientUser = req.user;
  const source = String(req.query.source || "").trim();
  const since = req.query.since;
  const ownerFilters = await buildPatientPrescriptionOwnerFilters(patientUser);

  if (!ownerFilters.length) {
    return res.status(200).json({
      success: true,
      total: 0,
      data: [],
    });
  }

  const filter = { $or: ownerFilters };

  if (source === "doctor_generated" || source === "patient_uploaded") {
    filter.source = source;
  }

  if (since) {
    filter.updatedAt = { $gt: new Date(since) };
  }

  const prescriptions = await Prescription.find(filter)
    .select(
      "source hospitalId doctorUserId patientUserId uploadedByPatientUserId patientId patientName diagnosis prescriptionDate followUpDate instruction medicines doctorName hospitalName hospitalAddress document"
    )
    .sort({ prescriptionDate: -1, createdAt: -1 })
    .populate("hospitalId", "name city phone address")
    .populate("doctorUserId", "name")
    .limit(100)
    .lean();

  res.status(200).json({
    success: true,
    total: prescriptions.length,
    data: prescriptions.map(mapPrescription),
  });
});

exports.createAvatarUploadSession = catchAsync(async (req, res, next) => {
  const contentType = String(req.body.contentType || "").trim().toLowerCase();
  const fileSize = Number(req.body.fileSize);

  if (!ALLOWED_IMAGE_MIME_TYPES.includes(contentType)) {
    return next(new AppError("Upload a JPG, PNG, or WEBP profile photo.", 400));
  }

  if (!Number.isFinite(fileSize) || fileSize < 1 || fileSize > MAX_AVATAR_UPLOAD_BYTES) {
    return next(
      new AppError(`Profile photo must be ${MAX_AVATAR_UPLOAD_BYTES / (1024 * 1024)} MB or smaller.`, 400)
    );
  }

  const objectKey = buildAvatarObjectKey({
    patientUserId: req.user._id,
    extension: extensionFromContentType(contentType),
  });

  const { url, expiresIn } = await createMediaUploadUrl({
    key: objectKey,
    contentType,
    expiresIn: UPLOAD_SESSION_TTL_SECONDS,
  });

  const uploadToken = jwt.sign(
    {
      purpose: AVATAR_UPLOAD_SESSION_PURPOSE,
      patientUserId: req.user._id.toString(),
      objectKey,
      contentType,
      fileSize,
    },
    process.env.JWT_SECRET,
    { expiresIn: UPLOAD_SESSION_TTL_SECONDS }
  );

  res.status(200).json({
    success: true,
    message: "Avatar upload session created.",
    data: {
      uploadUrl: url,
      uploadToken,
      expiresIn,
      contentType,
    },
  });
});

exports.completeAvatarUpload = catchAsync(async (req, res, next) => {
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
    decoded.purpose !== AVATAR_UPLOAD_SESSION_PURPOSE ||
    decoded.patientUserId !== req.user._id.toString()
  ) {
    return next(new AppError("Upload session is invalid. Please try again.", 400));
  }

  let imageBuffer;
  try {
    imageBuffer = await getMediaObjectBuffer(decoded.objectKey);
  } catch {
    return next(new AppError("Upload your profile photo before completing.", 400));
  }

  if (!imageBuffer.length || imageBuffer.length > MAX_AVATAR_UPLOAD_BYTES) {
    return next(new AppError("Uploaded profile photo is too large.", 413));
  }

  if (imageBuffer.length > Number(decoded.fileSize) + 64 * 1024) {
    return next(new AppError("Uploaded file does not match the selected profile photo.", 400));
  }

  const patientUser = req.user;
  const previousAvatar = patientUser.avatar;

  if (previousAvatar && isStoredMediaKey(previousAvatar) && previousAvatar !== decoded.objectKey) {
    try {
      await deleteMediaObject(previousAvatar);
    } catch {
      // Ignore cleanup failures for replaced avatars.
    }
  }

  patientUser.avatar = decoded.objectKey;
  await patientUser.save();

  const avatarUrl = await resolveProfileAvatar(patientUser.avatar);

  res.status(200).json({
    success: true,
    message: "Profile photo updated successfully.",
    data: {
      avatar: avatarUrl,
      avatarKey: patientUser.avatar,
    },
  });
});

const normalizePrescriptionUploadMetadata = (body) => {
  const prescriptionDate = body.prescriptionDate
    ? parseDateValue(body.prescriptionDate)
    : new Date();

  if (!prescriptionDate) {
    throw new AppError("Select a valid prescription date.", 400);
  }

  return {
    diagnosis: String(body.diagnosis || "Uploaded prescription").trim() || "Uploaded prescription",
    doctorName: String(body.doctorName || "").trim(),
    hospitalName: String(body.hospitalName || "").trim(),
    hospitalAddress: String(body.hospitalAddress || "").trim(),
    instruction: String(body.instruction || "").trim(),
    prescriptionDate,
  };
};

const savePatientPrescriptionFromFile = async ({ patientUser, file, metadata, ip }) => {
  const ownerFilters = getPatientRecordOwnerFilters(patientUser);
  const patientRecord = ownerFilters.length
    ? await Patient.findOne({ $or: ownerFilters }).sort({ updatedAt: -1, createdAt: -1 }).lean()
    : null;

  const prescription = new Prescription({
    source: "patient_uploaded",
    hospitalId: null,
    doctorId: null,
    doctorUserId: null,
    patientUserId: patientUser._id,
    uploadedByPatientUserId: patientUser._id,
    patientId: patientRecord?._id || null,
    patientName: patientUser.name,
    diagnosis: metadata.diagnosis,
    prescriptionDate: metadata.prescriptionDate,
    followUpDate: null,
    instruction: metadata.instruction,
    doctorName: metadata.doctorName,
    hospitalName: metadata.hospitalName,
    hospitalAddress: metadata.hospitalAddress,
    medicines: [],
    originalUpload: {
      fileName: file.originalname,
      contentType: file.mimetype,
      size: file.size,
      uploadedAt: new Date(),
    },
  });

  const fileName = buildPrescriptionFileName(prescription);
  const pdfBuffer = await generateUploadedPrescriptionPdfBuffer({
    file,
    patientUser,
    prescription,
  });

  const objectKey = buildPrescriptionObjectKey({
    hospitalId: null,
    patientOwnerId: patientUser._id,
    prescriptionId: prescription._id,
    source: "patient-uploaded",
    extension: "pdf",
  });

  const document = await uploadPrescriptionObject({
    key: objectKey,
    body: pdfBuffer,
    contentType: "application/pdf",
    fileName,
    metadata: {
      prescriptionId: prescription._id,
      patientUserId: patientUser._id,
      source: "patient-uploaded",
    },
  });

  prescription.document = document;
  await prescription.save();

  await recordActivity({
    action: "PATIENT_PRESCRIPTION_UPLOADED",
    entity: "Prescription",
    entityId: prescription._id,
    user: patientUser,
    description: "Patient uploaded a prescription photo",
    ip,
    meta: {
      fileName: file.originalname,
      size: file.size,
    },
  });

  return prescription;
};

exports.createPrescriptionUploadSession = catchAsync(async (req, res, next) => {
  if ((req.user.prescriptionCredits || 0) <= 0) {
    return next(new AppError("Insufficient prescription credits. Please purchase a plan.", 400));
  }

  const contentType = String(req.body.contentType || "").trim().toLowerCase();
  const fileName = String(req.body.fileName || "prescription.jpg").trim();
  const fileSize = Number(req.body.fileSize);

  if (!ALLOWED_PRESCRIPTION_MIME_TYPES.includes(contentType)) {
    return next(new AppError("Upload a JPG, PNG, WEBP, or HEIC prescription photo.", 400));
  }

  if (!Number.isFinite(fileSize) || fileSize < 1 || fileSize > MAX_PRESCRIPTION_UPLOAD_BYTES) {
    return next(
      new AppError(`Prescription photo must be ${MAX_PRESCRIPTION_UPLOAD_BYTES / (1024 * 1024)} MB or smaller.`, 400)
    );
  }

  let metadata;
  try {
    metadata = normalizePrescriptionUploadMetadata(req.body);
  } catch (error) {
    return next(error);
  }

  const prescriptionId = new mongoose.Types.ObjectId();
  const tempKey = buildPrescriptionObjectKey({
    hospitalId: null,
    patientOwnerId: req.user._id,
    prescriptionId,
    source: "upload-temp",
    extension: extensionFromContentType(contentType),
  });

  const { url, expiresIn } = await createPrescriptionUploadUrl({
    key: tempKey,
    contentType,
    expiresIn: PRESCRIPTION_UPLOAD_SESSION_TTL_SECONDS,
  });

  const uploadToken = jwt.sign(
    {
      purpose: PRESCRIPTION_UPLOAD_SESSION_PURPOSE,
      patientUserId: req.user._id.toString(),
      prescriptionId: prescriptionId.toString(),
      tempKey,
      contentType,
      fileName,
      fileSize,
      diagnosis: metadata.diagnosis,
      doctorName: metadata.doctorName,
      hospitalName: metadata.hospitalName,
      hospitalAddress: metadata.hospitalAddress,
      instruction: metadata.instruction,
      prescriptionDate: metadata.prescriptionDate.toISOString(),
    },
    process.env.JWT_SECRET,
    { expiresIn: PRESCRIPTION_UPLOAD_SESSION_TTL_SECONDS }
  );

  res.status(200).json({
    success: true,
    message: "Upload session created.",
    data: {
      uploadUrl: url,
      uploadToken,
      expiresIn,
      contentType,
    },
  });
});

exports.completePrescriptionUpload = catchAsync(async (req, res, next) => {
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
    decoded.purpose !== PRESCRIPTION_UPLOAD_SESSION_PURPOSE ||
    decoded.patientUserId !== req.user._id.toString()
  ) {
    return next(new AppError("Upload session is invalid. Please try again.", 400));
  }

  let imageBuffer;
  try {
    imageBuffer = await getPrescriptionObjectBuffer(decoded.tempKey);
  } catch {
    return next(new AppError("Upload the prescription photo before completing.", 400));
  }

  if (!imageBuffer.length || imageBuffer.length > MAX_PRESCRIPTION_UPLOAD_BYTES) {
    return next(new AppError("Uploaded prescription photo is too large.", 413));
  }

  if (imageBuffer.length > Number(decoded.fileSize) + 64 * 1024) {
    return next(new AppError("Uploaded file does not match the selected prescription photo.", 400));
  }

  // Atomically deduct 1 prescription credit
  const updatedUser = await PatientUser.findOneAndUpdate(
    { _id: req.user._id, prescriptionCredits: { $gt: 0 } },
    { $inc: { prescriptionCredits: -1 } },
    { new: true }
  );

  if (!updatedUser) {
    return next(new AppError("Insufficient prescription credits. Please purchase a plan.", 400));
  }

  const file = {
    originalname: decoded.fileName || "prescription.jpg",
    mimetype: decoded.contentType || "image/jpeg",
    size: imageBuffer.length,
    buffer: imageBuffer,
  };

  let prescription;
  try {
    prescription = await savePatientPrescriptionFromFile({
      patientUser: req.user,
      file,
      metadata: {
        diagnosis: decoded.diagnosis,
        doctorName: decoded.doctorName,
        hospitalName: decoded.hospitalName,
        hospitalAddress: decoded.hospitalAddress,
        instruction: decoded.instruction,
        prescriptionDate: new Date(decoded.prescriptionDate),
      },
      ip: req.ip,
    });
  } catch (error) {
    // Refund credit since saving failed
    await PatientUser.findByIdAndUpdate(req.user._id, { $inc: { prescriptionCredits: 1 } });
    return next(error);
  }

  // Log consumption
  const CreditTransaction = require("../models/CreditTransaction");
  await CreditTransaction.create({
    userId: req.user._id,
    creditType: "prescription",
    type: "consumption",
    amount: 1,
    reason: "prescription_upload",
    performedBy: "system",
    metadata: { prescriptionId: prescription._id },
  });

  deletePrescriptionObject(decoded.tempKey).catch(() => {});

  res.status(201).json({
    success: true,
    message: "Prescription uploaded successfully.",
    data: mapPrescription(prescription.toObject()),
  });
});

exports.uploadPrescription = catchAsync(async (req, res, next) => {
  if (!req.file) {
    return next(new AppError("Upload a prescription photo.", 400));
  }

  let metadata;
  try {
    metadata = normalizePrescriptionUploadMetadata(req.body);
  } catch (error) {
    return next(error);
  }

  // Atomically deduct 1 prescription credit
  const updatedUser = await PatientUser.findOneAndUpdate(
    { _id: req.user._id, prescriptionCredits: { $gt: 0 } },
    { $inc: { prescriptionCredits: -1 } },
    { new: true }
  );

  if (!updatedUser) {
    return next(new AppError("Insufficient prescription credits. Please purchase a plan.", 400));
  }

  let prescription;
  try {
    prescription = await savePatientPrescriptionFromFile({
      patientUser: req.user,
      file: req.file,
      metadata,
      ip: req.ip,
    });
  } catch (error) {
    // Refund credit since saving failed
    await PatientUser.findByIdAndUpdate(req.user._id, { $inc: { prescriptionCredits: 1 } });
    return next(error);
  }

  // Log consumption
  const CreditTransaction = require("../models/CreditTransaction");
  await CreditTransaction.create({
    userId: req.user._id,
    creditType: "prescription",
    type: "consumption",
    amount: 1,
    reason: "prescription_upload",
    performedBy: "system",
    metadata: { prescriptionId: prescription._id },
  });

  res.status(201).json({
    success: true,
    message: "Prescription uploaded successfully.",
    data: mapPrescription(prescription.toObject()),
  });
});

exports.getPrescriptionDownload = catchAsync(async (req, res, next) => {
  const filter = await buildPatientPrescriptionAccessFilter(req.user, req.params.id);
  const prescription = await Prescription.findOne(filter).lean();

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

exports.deletePrescription = catchAsync(async (req, res, next) => {
  const prescription = await Prescription.findById(req.params.id);

  if (!prescription) {
    return next(new AppError("Prescription not found.", 404));
  }

  // Ensure it is a patient uploaded prescription
  if (prescription.source !== "patient_uploaded") {
    return next(new AppError("You can only delete patient-uploaded prescriptions.", 403));
  }

  // Ensure the logged-in patient is the owner of the prescription
  if (
    prescription.uploadedByPatientUserId?.toString() !== req.user._id.toString() &&
    prescription.patientUserId?.toString() !== req.user._id.toString()
  ) {
    return next(new AppError("You are not authorized to delete this prescription.", 403));
  }

  // Delete from S3 storage if there is an associated key
  if (prescription.document?.key) {
    try {
      await deletePrescriptionObject(prescription.document.key);
    } catch (s3Error) {
      // Log error but proceed with database deletion so the user isn't stuck with a broken entry
      console.error(`Failed to delete S3 object: ${prescription.document.key}`, s3Error);
    }
  }

  // Delete from MongoDB
  await Prescription.findByIdAndDelete(prescription._id);

  // Record activity
  await recordActivity({
    action: "PATIENT_PRESCRIPTION_DELETED",
    entity: "Prescription",
    entityId: prescription._id,
    user: req.user,
    description: "Patient deleted their uploaded prescription",
    ip: req.ip,
    meta: {
      fileName: prescription.document?.fileName || "",
      size: prescription.document?.size || 0,
    },
  });

  res.status(200).json({
    success: true,
    message: "Prescription deleted successfully.",
  });
});

exports.updateProfile = catchAsync(async (req, res, next) => {
  const { name, email, phone, age, gender, bloodGroup, emergencyContact, address, avatar, height, weight, allergies } = req.body;

  const patientUser = req.user;

  // Validate email uniqueness if changing
  if (email && email.toLowerCase() !== patientUser.email.toLowerCase()) {
    const existingEmail = await PatientUser.findOne({ email: email.toLowerCase() });
    if (existingEmail) {
      return next(new AppError("Email is already in use by another account.", 409));
    }
  }

  // Validate phone uniqueness if changing
  if (phone && phone !== patientUser.phone) {
    const existingPhone = await PatientUser.findOne({ phone });
    if (existingPhone) {
      return next(new AppError("Phone number is already in use by another account.", 409));
    }
  }

  // Find all Patient records (hospital records) linked to this patient's current email or phone
  const patientFilters = [];
  if (patientUser.email) patientFilters.push({ email: patientUser.email });
  const phoneFilters = getPhoneFilters(patientUser.phone);
  phoneFilters.forEach((p) => patientFilters.push({ phone: p }));

  const patientRecords = patientFilters.length
    ? await Patient.find({ $or: patientFilters })
    : [];

  if (avatar !== undefined && avatar !== null) {
    const trimmedAvatar = String(avatar).trim();

    if (
      trimmedAvatar &&
      !isStoredMediaKey(trimmedAvatar) &&
      !/^https?:\/\//i.test(trimmedAvatar)
    ) {
      return next(
        new AppError("Profile photo must be uploaded through the avatar upload flow.", 400)
      );
    }

    if (trimmedAvatar === "") {
      if (patientUser.avatar && isStoredMediaKey(patientUser.avatar)) {
        try {
          await deleteMediaObject(patientUser.avatar);
        } catch {
          // Ignore cleanup failures when clearing avatar.
        }
      }
      patientUser.avatar = null;
    } else if (trimmedAvatar !== patientUser.avatar) {
      patientUser.avatar = trimmedAvatar;
    }
  }

  // Update PatientUser model
  if (name) patientUser.name = name;
  if (email) patientUser.email = email;
  if (phone) patientUser.phone = phone;
  if (age !== undefined) patientUser.age = age;
  if (gender !== undefined) patientUser.gender = gender || null;
  if (bloodGroup !== undefined) patientUser.bloodGroup = bloodGroup || null;
  if (emergencyContact !== undefined) patientUser.emergencyContact = emergencyContact || null;
  if (address !== undefined) patientUser.address = address || null;
  if (height !== undefined) patientUser.height = height;
  if (weight !== undefined) patientUser.weight = weight;
  if (allergies !== undefined) patientUser.allergies = allergies;

  await patientUser.save();

  // Update all matching Patient records at hospitals
  if (patientRecords.length > 0) {
    const updateData = {};
    if (age !== undefined) updateData.age = age;
    if (gender !== undefined) updateData.gender = gender;
    if (bloodGroup !== undefined) updateData.bloodGroup = bloodGroup;
    if (emergencyContact !== undefined) updateData.emergencyContact = emergencyContact;
    if (address !== undefined) updateData.address = address;

    if (email) updateData.email = email;
    if (phone) updateData.phone = phone;

    if (name) {
      const parts = name.trim().split(/\s+/);
      updateData.firstName = parts[0] || "";
      updateData.lastName = parts.slice(1).join(" ") || "";
    }

    await Patient.updateMany(
      { _id: { $in: patientRecords.map((r) => r._id) } },
      { $set: updateData }
    );
  }

  const bestPatientRecord = pickBestPatientRecord(patientRecords, patientUser);
  const profileCompletion = buildProfileCompletion(patientUser, bestPatientRecord);

  const avatarUrl = await resolveProfileAvatar(patientUser.avatar);

  res.status(200).json({
    success: true,
    message: "Profile updated successfully.",
    user: {
      id: patientUser._id,
      name: patientUser.name,
      email: patientUser.email,
      phone: patientUser.phone,
      avatar: avatarUrl,
    },
    data: {
      profileCompletion,
      patientRecord: resolveProfileRecordFields(patientUser, bestPatientRecord),
    },
  });
});

exports.getPatientReceipts = catchAsync(async (req, res, next) => {
  const patientUser = req.user;
  const patientFilters = getPatientRecordOwnerFilters(patientUser);
  const patientRecords = patientFilters.length
    ? await Patient.find({ $or: patientFilters }).select("_id").lean()
    : [];
  const patientRecordIds = patientRecords.map((record) => record._id);

  if (!patientRecordIds.length) {
    return res.status(200).json({
      success: true,
      data: [],
    });
  }

  const receipts = await Receipt.find({
    patientId: { $in: patientRecordIds },
  })
    .populate("doctorId", "firstName lastName specialization department")
    .populate("hospitalId", "name address phone email website logoUrl")
    .sort({ createdAt: -1 });

  res.status(200).json({
    success: true,
    data: receipts,
  });
});

exports.getPatientReceiptDownload = catchAsync(async (req, res, next) => {
  const patientUser = req.user;
  const receiptId = req.params.id;

  const patientFilters = getPatientRecordOwnerFilters(patientUser);
  const patientRecords = patientFilters.length
    ? await Patient.find({ $or: patientFilters }).select("_id").lean()
    : [];
  const patientRecordIds = patientRecords.map((record) => record._id);

  if (!patientRecordIds.length) {
    return next(new AppError("Receipt not found or access denied.", 404));
  }

  const receipt = await Receipt.findOne({
    _id: receiptId,
    patientId: { $in: patientRecordIds },
  });

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
    expiresIn: 3600,
  });

  await recordActivity({
    action: "PATIENT_RECEIPT_DOWNLOADED",
    entity: "Receipt",
    entityId: receipt._id,
    user: req.user,
    description: `Patient viewed/downloaded receipt ${receipt.receiptNumber}`,
    ip: req.ip,
  });

  res.status(200).json({
    success: true,
    data: {
      url: downloadUrl,
      expiresIn: 3600,
    },
  });
});

// ─── Reports Management Controllers ───────────────────────────────────────────

const ALLOWED_REPORT_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const MAX_REPORT_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

exports.createReportUploadSession = catchAsync(async (req, res, next) => {
  if ((req.user.reportCredits || 0) <= 0) {
    return next(new AppError("Insufficient report credits. Please purchase a plan.", 400));
  }

  const contentType = String(req.body.contentType || "").trim().toLowerCase();
  const fileName = String(req.body.fileName || "report.pdf").trim();
  const fileSize = Number(req.body.fileSize);

  if (!ALLOWED_REPORT_MIME_TYPES.includes(contentType)) {
    return next(new AppError("Upload a valid PDF, JPG, PNG, DOC, or DOCX medical report.", 400));
  }

  if (!Number.isFinite(fileSize) || fileSize < 1 || fileSize > MAX_REPORT_UPLOAD_BYTES) {
    return next(
      new AppError(`Report file must be ${MAX_REPORT_UPLOAD_BYTES / (1024 * 1024)} MB or smaller.`, 400)
    );
  }

  const reportId = new mongoose.Types.ObjectId();
  const s3Key = reportStorage.buildReportObjectKey({
    patientUserId: req.user._id,
    reportId,
    fileName,
  });

  const { url, expiresIn } = await reportStorage.createReportUploadUrl({
    key: s3Key,
    contentType,
    fileSize,
    expiresIn: 3600,
  });

  const uploadToken = jwt.sign(
    {
      purpose: "report-upload",
      patientUserId: req.user._id.toString(),
      reportId: reportId.toString(),
      s3Key,
      contentType,
      fileName,
      fileSize,
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  res.status(200).json({
    success: true,
    message: "Report upload session created.",
    data: {
      uploadUrl: url,
      uploadToken,
      expiresIn,
      contentType,
    },
  });
});

exports.completeReportUpload = catchAsync(async (req, res, next) => {
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
    decoded.purpose !== "report-upload" ||
    decoded.patientUserId !== req.user._id.toString()
  ) {
    return next(new AppError("Upload session is invalid. Please try again.", 400));
  }

  // Atomically deduct 1 report credit from patient user account
  const updatedUser = await PatientUser.findOneAndUpdate(
    { _id: req.user._id, reportCredits: { $gt: 0 } },
    { $inc: { reportCredits: -1 } },
    { new: true }
  );

  if (!updatedUser) {
    return next(new AppError("Insufficient report credits. Please purchase a plan.", 400));
  }

  // Log consumption
  const CreditTransaction = require("../models/CreditTransaction");
  await CreditTransaction.create({
    userId: req.user._id,
    creditType: "report",
    type: "consumption",
    amount: 1,
    reason: "report_upload",
    performedBy: "system",
    metadata: { reportId: decoded.reportId },
  });

  // Verify file exists in S3 storage
  let s3Metadata;
  try {
    s3Metadata = await reportStorage.getReportObjectMetadata(decoded.s3Key);
  } catch (error) {
    // Refund credit since S3 check failed
    await PatientUser.findByIdAndUpdate(req.user._id, { $inc: { reportCredits: 1 } });
    await CreditTransaction.create({
      userId: req.user._id,
      creditType: "report",
      type: "addition",
      amount: 1,
      reason: "report_upload_refund",
      performedBy: "system",
      metadata: { reportId: decoded.reportId },
    });
    return next(error);
  }

  // Save Report record in MongoDB
  const report = await Report.create({
    _id: decoded.reportId,
    userId: req.user._id,
    fileName: decoded.fileName,
    fileSize: s3Metadata.size || decoded.fileSize,
    contentType: decoded.contentType,
    s3Key: decoded.s3Key,
    fileUrl: `https://${process.env.AWS_S3_BUCKET}.s3.amazonaws.com/${decoded.s3Key}`,
    uploadedAt: new Date(),
  });

  // ── Storage tracking (fire-and-forget) ────────────────────────────────────
  void trackUpload({
    bucket: process.env.AWS_S3_BUCKET || "",
    s3Key: decoded.s3Key,
    originalName: decoded.fileName,
    fileName: decoded.fileName,
    module: STORAGE_MODULES.LAB_REPORT,
    mimeType: decoded.contentType,
    fileSizeBytes: s3Metadata.size || decoded.fileSize,
    uploadedBy: req.user._id,
    uploadedByModel: "PatientUser",
  });

  // Record audit log
  await recordActivity({
    action: "PATIENT_REPORT_UPLOADED",
    entity: "Report",
    entityId: report._id,
    user: req.user,
    description: `Patient uploaded report: ${report.fileName}`,
    ip: req.ip,
    meta: {
      fileName: report.fileName,
      fileSize: report.fileSize,
      contentType: report.contentType,
      remainingCredits: updatedUser.reportCredits,
    },
  });

  res.status(201).json({
    success: true,
    message: "Report uploaded successfully.",
    data: {
      id: String(report._id),
      fileName: report.fileName,
      fileSize: report.fileSize,
      contentType: report.contentType,
      uploadedAt: report.uploadedAt,
      downloadUrl: `/files/${report._id}/download`,
    },
  });
});

exports.getReports = catchAsync(async (req, res, next) => {
  const reports = await Report.find({ userId: req.user._id })
    .sort({ uploadedAt: -1, createdAt: -1 })
    .lean();

  const mappedReports = reports.map((r) => ({
    id: String(r._id),
    fileName: r.fileName,
    fileSize: r.fileSize,
    contentType: r.contentType,
    uploadedAt: r.uploadedAt,
    downloadUrl: `/files/${r._id}/download`,
  }));

  res.status(200).json({
    success: true,
    total: reports.length,
    data: mappedReports,
  });
});

exports.getReportDownload = catchAsync(async (req, res, next) => {
  const report = await Report.findOne({ _id: req.params.id, userId: req.user._id }).lean();

  if (!report) {
    return next(new AppError("Report not found.", 404));
  }

  const { url } = await reportStorage.createReportDownloadUrl({
    key: report.s3Key,
    fileName: report.fileName,
    contentType: report.contentType,
    expiresIn: 3600,
  });

  res.status(200).json({
    success: true,
    data: {
      url,
      expiresIn: 3600,
    },
  });
});

exports.deleteReport = catchAsync(async (req, res, next) => {
  const report = await Report.findOne({ _id: req.params.id, userId: req.user._id });

  if (!report) {
    return next(new AppError("Report not found.", 404));
  }

  // Delete from S3
  try {
    await reportStorage.deleteReportObject(report.s3Key);
  } catch (s3Error) {
    logger.error(`S3 delete failed for report key ${report.s3Key}: ${s3Error.message}`);
  }

  // Delete from DB
  await Report.findByIdAndDelete(report._id);

  // Record audit log
  await recordActivity({
    action: "PATIENT_REPORT_DELETED",
    entity: "Report",
    entityId: report._id,
    user: req.user,
    description: `Patient deleted report: ${report.fileName}`,
    ip: req.ip,
  });

  res.status(200).json({
    success: true,
    message: "Report deleted successfully.",
  });
});

exports.getCreditHistory = catchAsync(async (req, res, next) => {
  const CreditTransaction = require("../models/CreditTransaction");
  const history = await CreditTransaction.find({ userId: req.user._id })
    .sort({ createdAt: -1 })
    .lean();

  res.status(200).json({
    success: true,
    data: history.map((h) => ({
      id: h._id,
      creditType: h.creditType,
      type: h.type,
      amount: h.amount,
      reason: h.reason,
      createdAt: h.createdAt,
    })),
  });
});

