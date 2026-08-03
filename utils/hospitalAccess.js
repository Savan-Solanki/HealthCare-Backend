const Hospital = require("../models/Hospital");
const AppError = require("./AppError");

const DEMO_WARNING_DAYS = 3;

const getHospitalIdValue = (hospitalRef) => {
  if (!hospitalRef) return null;
  if (typeof hospitalRef === "object" && hospitalRef._id) return String(hospitalRef._id);
  return String(hospitalRef);
};

const isDemoExpired = (hospital) => {
  if (!hospital) return false;
  const type = hospital.subscriptionType || hospital.accessType;
  if (type !== "demo") return false;
  const expiry = hospital.demoExpiryDate || hospital.demoExpiresAt;
  if (!expiry) return false;
  return new Date(expiry).getTime() <= Date.now() || hospital.subscriptionStatus === "expired" || hospital.status === "Inactive";
};

const getDemoDaysRemaining = (hospital) => {
  const expiry = hospital?.demoExpiryDate || hospital?.demoExpiresAt;
  if (!expiry) return null;
  const diffMs = new Date(expiry).getTime() - Date.now();
  return Math.max(0, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));
};

const loadHospitalAccessRecord = async (hospitalRef) => {
  const hospitalId = getHospitalIdValue(hospitalRef);
  if (!hospitalId) return null;

  return Hospital.findById(hospitalId).select(
    "name status accessType demoExpiresAt demoDurationDays demoStartedAt demoWarningEmailSentAt adminId subscriptionType demoStartDate demoExpiryDate subscriptionStatus isArchived"
  );
};

const assertHospitalPortalAccess = async (user, { populateHospital = false } = {}) => {
  if (!user || user.role === "Super Admin") return null;

  const hospitalId = getHospitalIdValue(user.hospitalId);
  if (!hospitalId) return null;

  const hospital =
    populateHospital && user.hospitalId && typeof user.hospitalId === "object"
      ? user.hospitalId
      : await loadHospitalAccessRecord(hospitalId);

  if (!hospital) return null;

  if (hospital.status === "Inactive") {
    const isDemo = (hospital.subscriptionType || hospital.accessType) === "demo";
    if (isDemo && (isDemoExpired(hospital) || hospital.subscriptionStatus === "expired")) {
      throw new AppError(
        "Hospital Demo Period Expired. Please contact Super Admin.",
        403
      );
    }
    throw new AppError(
      "Hospital portal access is suspended. Contact medikwik administrators to restore access.",
      403
    );
  }

  if (isDemoExpired(hospital)) {
    throw new AppError(
      "Hospital Demo Period Expired. Please contact Super Admin.",
      403
    );
  }

  return hospital;
};

const createHospitalAuditLog = async (hospitalId, action, performedBy) => {
  const HospitalAuditLog = require("../models/HospitalAuditLog");
  const logger = require("./logger");
  try {
    await HospitalAuditLog.create({
      hospitalId,
      action,
      performedBy: performedBy || "System",
      timestamp: new Date(),
    });
  } catch (err) {
    logger.error(`Failed to write hospital audit log: ${err.message}`);
  }
};

const verifyHospitalStaffLimits = async (hospitalId, role) => {
  if (!hospitalId) return;

  const User = require("../models/User");
  const Staff = require("../models/Staff");
  const Doctor = require("../models/Doctor");

  const hospital = await Hospital.findById(hospitalId);
  if (!hospital) return;

  const roleStr = String(role).trim().toLowerCase();

  if (roleStr === "doctor") {
    const limit = (hospital.maxDoctors !== null && hospital.maxDoctors !== undefined)
      ? hospital.maxDoctors
      : (hospital.doctors && hospital.doctors > 0 ? hospital.doctors : 3);
    const currentDoctorCount = await Doctor.countDocuments({ hospitalId });
    const userDoctorCount = await User.countDocuments({ hospitalId, role: "Doctor" });
    const total = Math.max(currentDoctorCount, userDoctorCount);
    if (total >= limit) {
      throw new AppError("Doctor limit reached for this hospital.", 403);
    }
  } else if (roleStr === "receptionist") {
    const limit = (hospital.maxReceptionists !== null && hospital.maxReceptionists !== undefined)
      ? hospital.maxReceptionists
      : 3;
    const userCount = await User.countDocuments({ hospitalId, role: "Receptionist" });
    const staffCount = await Staff.countDocuments({ hospitalId, role: { $regex: /^receptionist$/i } });
    const total = userCount + staffCount;
    if (total >= limit) {
      throw new AppError("Receptionist limit reached for this hospital.", 403);
    }
  } else if (roleStr === "nurse") {
    const limit = (hospital.maxNurses !== null && hospital.maxNurses !== undefined)
      ? hospital.maxNurses
      : 3;
    const userCount = await User.countDocuments({ hospitalId, role: "Nurse" });
    const staffCount = await Staff.countDocuments({ hospitalId, role: { $regex: /^nurse$/i } });
    const total = userCount + staffCount;
    if (total >= limit) {
      throw new AppError("Nurse limit reached for this hospital.", 403);
    }
  } else if (roleStr === "staff") {
    const limit = (hospital.maxStaff !== null && hospital.maxStaff !== undefined)
      ? hospital.maxStaff
      : 3;
    const userCount = await User.countDocuments({ hospitalId, role: "Staff" });
    const staffCount = await Staff.countDocuments({ hospitalId, role: { $not: /receptionist|nurse/i } });
    const total = userCount + staffCount;
    if (total >= limit) {
      throw new AppError("Staff limit reached for this hospital.", 403);
    }
  }
};

const applyDemoAccessToHospital = async ({
  hospitalId,
  accessType = "permanent",
  demoDays,
  demoStartDate,
  performedBy = "System",
}) => {
  const update = {
    accessType: accessType === "demo" ? "demo" : "permanent",
    subscriptionType: accessType === "demo" ? "demo" : "permanent",
    demoWarningEmailSentAt: null,
    demoExpiredNotifiedAt: null,
    subscriptionStatus: "active",
    status: "Active",
    expiryEmail7DaysSent: false,
    expiryEmail3DaysSent: false,
    expiryEmail1DaySent: false,
    expiryEmail0DaySent: false,
  };

  if (accessType === "demo") {
    const durationDays = Math.max(1, Number(demoDays) || 0);
    if (!durationDays) {
      throw new AppError("Demo duration in days is required for demo hospital access.", 400);
    }

    const startedAt = demoStartDate ? new Date(demoStartDate) : new Date();
    if (isNaN(startedAt.getTime())) {
      throw new AppError("Invalid demo start date.", 400);
    }
    const expiresAt = new Date(startedAt);
    expiresAt.setDate(expiresAt.getDate() + durationDays);

    update.demoDurationDays = durationDays;
    update.demoStartedAt = startedAt;
    update.demoStartDate = startedAt;
    update.demoExpiresAt = expiresAt;
    update.demoExpiryDate = expiresAt;
  } else {
    update.demoDurationDays = null;
    update.demoStartedAt = null;
    update.demoStartDate = null;
    update.demoExpiresAt = null;
    update.demoExpiryDate = null;
  }

  const updatedHospital = await Hospital.findByIdAndUpdate(hospitalId, update, { new: true, runValidators: true });
  await createHospitalAuditLog(hospitalId, "Subscription Changed", performedBy);
  return updatedHospital;
};

module.exports = {
  DEMO_WARNING_DAYS,
  applyDemoAccessToHospital,
  assertHospitalPortalAccess,
  getDemoDaysRemaining,
  getHospitalIdValue,
  isDemoExpired,
  loadHospitalAccessRecord,
  createHospitalAuditLog,
  verifyHospitalStaffLimits,
};
