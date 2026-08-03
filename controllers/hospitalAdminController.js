const Patient = require("../models/Patient");
const Doctor = require("../models/Doctor");
const Department = require("../models/Department");
const Staff = require("../models/Staff");
const Appointment = require("../models/Appointment");
const Hospital = require("../models/Hospital");
const User = require("../models/User");
const AppError = require("../utils/AppError");
const {
  createPatientAppointmentConfirmationNotification,
  createPatientAppointmentStatusNotification,
  deleteAppointmentNotifications,
} = require("../utils/appointmentNotifications");
const catchAsync = require("../utils/catchAsync");
const recordActivity = require("../utils/recordActivity");

const resolveHospitalId = (value) => {
  if (!value) return null;
  if (typeof value === "object" && value._id) return value._id;
  return value;
};

const getScopedHospitalId = (req) => {
  const role = req.user.role;
  const assignedHospitalId = resolveHospitalId(req.user.hospitalId);

  if (role === "Hospital Admin" || role === "Receptionist" || role === "Doctor") {
    if (!assignedHospitalId) {
      throw new AppError(`${role} is not assigned to a hospital.`, 403);
    }
    return assignedHospitalId;
  }

  if (role === "Super Admin") {
    const requestedHospitalId = req.query.hospitalId || req.body.hospitalId;
    if (!requestedHospitalId) {
      throw new AppError("Hospital id is required.", 400);
    }
    return requestedHospitalId;
  }

  throw new AppError("You do not have permission to access this hospital resource.", 403);
};

const parseSearchFilter = (search, fields) => {
  if (!search) return {};

  const orQueries = [];
  const mongoose = require("mongoose");
  const isValidObjectId = mongoose.Types.ObjectId.isValid(search);
  const cleanSearch = search.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

  for (const field of fields) {
    if (field === "patientRecordId" || field === "patientUserId" || field === "_id") {
      if (isValidObjectId) {
        orQueries.push({ [field]: search });
      } else if (cleanSearch && /^[0-9a-f]+$/.test(cleanSearch)) {
        orQueries.push({
          $expr: {
            $regexMatch: {
              input: { $toString: { $ifNull: [`$${field}`, ""] } },
              regex: `${cleanSearch}$`,
              options: "i"
            }
          }
        });
      }
    } else {
      orQueries.push({ [field]: { $regex: search, $options: "i" } });
    }
  }

  return orQueries.length > 0 ? { $or: orQueries } : {};
};

const normalizeDoctorEmail = (email) => email?.trim().toLowerCase();
const buildDoctorUserName = ({ firstName, lastName }) => [firstName, lastName].filter(Boolean).join(" ").trim();

const buildCrudHandlers = ({
  Model,
  entity,
  searchFields,
  activityPrefix,
  listSort = { createdAt: -1 },
  afterCreate = null,
  afterUpdate = null,
  afterRemove = null,
  populate = "",
}) => {
  const getAll = catchAsync(async (req, res) => {
    const hospitalId = getScopedHospitalId(req);
    const filter = {
      hospitalId,
      ...parseSearchFilter(req.query.search, searchFields),
    };

    let query = Model.find(filter).sort(listSort);
    if (populate) {
      query = query.populate(populate);
    }
    const data = await query;

    res.status(200).json({
      success: true,
      total: data.length,
      data,
    });
  });

  const create = catchAsync(async (req, res) => {
    const hospitalId = getScopedHospitalId(req);
    const doc = await Model.create({ ...req.body, hospitalId });

    await recordActivity({
      action: `${activityPrefix}_CREATED`,
      entity,
      entityId: doc._id,
      user: req.user,
      description: `${entity} created`,
      ip: req.ip,
    });

    if (afterCreate) {
      await afterCreate(doc, req);
    }

    res.status(201).json({
      success: true,
      message: `${entity} created successfully.`,
      data: doc,
    });
  });

  const update = catchAsync(async (req, res, next) => {
    const hospitalId = getScopedHospitalId(req);
    const previousDoc = await Model.findOne({ _id: req.params.id, hospitalId }).lean();

    if (!previousDoc) return next(new AppError(`No ${entity.toLowerCase()} found with that ID.`, 404));

    const doc = await Model.findOneAndUpdate(
      { _id: req.params.id, hospitalId },
      req.body,
      { new: true, runValidators: true }
    );

    if (!doc) return next(new AppError(`No ${entity.toLowerCase()} found with that ID.`, 404));

    await recordActivity({
      action: `${activityPrefix}_UPDATED`,
      entity,
      entityId: doc._id,
      user: req.user,
      description: `${entity} updated`,
      ip: req.ip,
    });

    if (afterUpdate) {
      await afterUpdate(doc, req, previousDoc);
    }

    res.status(200).json({
      success: true,
      message: `${entity} updated successfully.`,
      data: doc,
    });
  });

  const remove = catchAsync(async (req, res, next) => {
    const hospitalId = getScopedHospitalId(req);
    const doc = await Model.findOneAndDelete({ _id: req.params.id, hospitalId });

    if (!doc) return next(new AppError(`No ${entity.toLowerCase()} found with that ID.`, 404));

    await recordActivity({
      action: `${activityPrefix}_DELETED`,
      entity,
      entityId: doc._id,
      user: req.user,
      description: `${entity} deleted`,
      ip: req.ip,
    });

    if (afterRemove) {
      await afterRemove(doc, req);
    }

    res.status(200).json({
      success: true,
      message: `${entity} deleted successfully.`,
    });
  });

  return { getAll, create, update, remove };
};

const patientHandlers = buildCrudHandlers({
  Model: Patient,
  entity: "Patient",
  searchFields: ["firstName", "lastName", "email", "phone", "bloodGroup", "_id"],
  activityPrefix: "PATIENT",
});

const departmentHandlers = buildCrudHandlers({
  Model: Department,
  entity: "Department",
  searchFields: ["departmentName", "departmentHead"],
  activityPrefix: "DEPARTMENT",
});

const staffHandlers = buildCrudHandlers({
  Model: Staff,
  entity: "Staff",
  searchFields: ["firstName", "lastName", "email", "department", "role"],
  activityPrefix: "STAFF",
});

const appointmentHandlers = buildCrudHandlers({
  Model: Appointment,
  entity: "Appointment",
  searchFields: [
    "patientName",
    "doctorName",
    "department",
    "status",
    "patientEmail",
    "patientPhone",
    "patientRecordId",
    "patientUserId",
    "_id",
  ],
  activityPrefix: "APPOINTMENT",
  listSort: { appointmentDate: -1, appointmentTime: 1 },
  populate: "patientRecordId",
  afterCreate: async (appointment, req) => {
    if (appointment.patientUserId) {
      const { emitToPatient, EVENTS } = require("../utils/realtimeEvents");
      emitToPatient(appointment.patientUserId, EVENTS.APPOINTMENT_CREATED, appointment.toObject());
    }

    const { emitToHospitalRole, EVENTS } = require("../utils/realtimeEvents");
    emitToHospitalRole(appointment.hospitalId, "Receptionist", EVENTS.APPOINTMENT_CREATED, appointment.toObject());
    emitToHospitalRole(appointment.hospitalId, "Hospital Admin", EVENTS.APPOINTMENT_CREATED, appointment.toObject());
  },
  afterUpdate: async (appointment, req, previousAppointment) => {
    await deleteAppointmentNotifications(appointment._id);
    const statusChanged = req.body.status && req.body.status !== previousAppointment?.status;

    if (statusChanged && appointment.patientUserId) {
      await createPatientAppointmentStatusNotification(appointment, req.body.status);
    }

    const { emitToPatient, emitToHospitalRole, EVENTS } = require("../utils/realtimeEvents");
    const event = req.body.status === "Cancelled" ? EVENTS.APPOINTMENT_CANCELLED : EVENTS.APPOINTMENT_UPDATED;

    if (appointment.patientUserId) {
      emitToPatient(appointment.patientUserId, event, appointment.toObject());
    }

    emitToHospitalRole(appointment.hospitalId, "Receptionist", EVENTS.APPOINTMENT_UPDATED, appointment.toObject());
    emitToHospitalRole(appointment.hospitalId, "Hospital Admin", EVENTS.APPOINTMENT_UPDATED, appointment.toObject());
  },
  afterRemove: async (appointment) => {
    await deleteAppointmentNotifications(appointment._id);

    const { emitToPatient, emitToHospitalRole, EVENTS } = require("../utils/realtimeEvents");
    if (appointment.patientUserId) {
      emitToPatient(appointment.patientUserId, EVENTS.APPOINTMENT_CANCELLED, appointment.toObject());
    }

    emitToHospitalRole(appointment.hospitalId, "Receptionist", EVENTS.APPOINTMENT_CANCELLED, appointment.toObject());
    emitToHospitalRole(appointment.hospitalId, "Hospital Admin", EVENTS.APPOINTMENT_CANCELLED, appointment.toObject());
  },
});

exports.getDashboard = catchAsync(async (req, res, next) => {
  const hospitalId = getScopedHospitalId(req);
  const hospital = await Hospital.findById(hospitalId).select(
    "name beds doctors city status type maxDoctors maxReceptionists maxNurses maxStaff subscriptionType subscriptionStatus demoStartDate demoExpiryDate demoExpiresAt accessType"
  );

  if (!hospital) {
    return next(new AppError("Assigned hospital was not found.", 404));
  }

  const hospitalObjectId = hospital._id;
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 7);

  const monthAnchors = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - (5 - index), 1);
    return {
      key: `${date.getFullYear()}-${date.getMonth() + 1}`,
      label: date.toLocaleString("en", { month: "short" }),
      month: date.getMonth() + 1,
      year: date.getFullYear(),
    };
  });
  const startOfTrend = new Date(monthAnchors[0].year, monthAnchors[0].month - 1, 1);

  const [
    totalPatients,
    totalDoctors,
    totalStaff,
    departmentCount,
    totalAppointments,
    todayAppointmentsCount,
    upcomingAppointments,
    pendingAppointments,
    confirmedAppointments,
    completedAppointments,
    cancelledAppointments,
    paidAppointments,
    pendingPayments,
    monthlyRevenueResult,
    totalRevenueResult,
    averageFeeResult,
    appointmentTrendResult,
    weeklyAppointmentsResult,
    statusBreakdownResult,
    paymentBreakdownResult,
    departmentLoadResult,
    doctorLoadResult,
    staffMixResult,
    appointmentsToday,
    upcomingVisits,
  ] = await Promise.all([
    Patient.countDocuments({ hospitalId }),
    Doctor.countDocuments({ hospitalId }),
    Staff.countDocuments({ hospitalId }),
    Department.countDocuments({ hospitalId }),
    Appointment.countDocuments({ hospitalId }),
    Appointment.countDocuments({
      hospitalId,
      appointmentDate: { $gte: startOfToday, $lte: endOfToday },
    }),
    Appointment.countDocuments({
      hospitalId,
      appointmentDate: { $gte: startOfToday },
      status: { $in: ["Scheduled", "Confirmed"] },
    }),
    Appointment.countDocuments({ hospitalId, status: "Scheduled" }),
    Appointment.countDocuments({ hospitalId, status: "Confirmed" }),
    Appointment.countDocuments({ hospitalId, status: "Completed" }),
    Appointment.countDocuments({ hospitalId, status: "Cancelled" }),
    Appointment.countDocuments({ hospitalId, paymentStatus: "Paid" }),
    Appointment.countDocuments({ hospitalId, paymentStatus: "Pending" }),
    Appointment.aggregate([
      {
        $match: {
          hospitalId: hospitalObjectId,
          paymentStatus: "Paid",
          appointmentDate: { $gte: startOfMonth, $lt: startOfNextMonth },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $ifNull: ["$consultationFee", 0] } },
        },
      },
    ]),
    Appointment.aggregate([
      {
        $match: {
          hospitalId: hospitalObjectId,
          paymentStatus: "Paid",
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $ifNull: ["$consultationFee", 0] } },
        },
      },
    ]),
    Appointment.aggregate([
      {
        $match: {
          hospitalId: hospitalObjectId,
          consultationFee: { $gt: 0 },
        },
      },
      {
        $group: {
          _id: null,
          average: { $avg: "$consultationFee" },
        },
      },
    ]),
    Appointment.aggregate([
      {
        $match: {
          hospitalId: hospitalObjectId,
          appointmentDate: { $gte: startOfTrend, $lt: startOfNextMonth },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: "$appointmentDate" },
            month: { $month: "$appointmentDate" },
          },
          appointments: { $sum: 1 },
          revenue: {
            $sum: {
              $cond: [
                { $eq: ["$paymentStatus", "Paid"] },
                { $ifNull: ["$consultationFee", 0] },
                0,
              ],
            },
          },
        },
      },
    ]),
    Appointment.aggregate([
      {
        $match: {
          hospitalId: hospitalObjectId,
          appointmentDate: { $gte: startOfWeek, $lt: endOfWeek },
        },
      },
      {
        $group: {
          _id: { $dayOfWeek: "$appointmentDate" },
          count: { $sum: 1 },
        },
      },
    ]),
    Appointment.aggregate([
      { $match: { hospitalId: hospitalObjectId } },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]),
    Appointment.aggregate([
      { $match: { hospitalId: hospitalObjectId } },
      {
        $group: {
          _id: "$paymentStatus",
          count: { $sum: 1 },
          amount: { $sum: { $ifNull: ["$consultationFee", 0] } },
        },
      },
    ]),
    Appointment.aggregate([
      {
        $match: {
          hospitalId: hospitalObjectId,
          appointmentDate: { $gte: startOfMonth, $lt: startOfNextMonth },
        },
      },
      {
        $group: {
          _id: { $ifNull: ["$department", "Unassigned"] },
          appointments: { $sum: 1 },
          revenue: {
            $sum: {
              $cond: [
                { $eq: ["$paymentStatus", "Paid"] },
                { $ifNull: ["$consultationFee", 0] },
                0,
              ],
            },
          },
        },
      },
      { $sort: { appointments: -1, _id: 1 } },
      { $limit: 6 },
    ]),
    Appointment.aggregate([
      {
        $match: {
          hospitalId: hospitalObjectId,
          appointmentDate: { $gte: startOfMonth, $lt: startOfNextMonth },
        },
      },
      {
        $group: {
          _id: "$doctorName",
          appointments: { $sum: 1 },
          revenue: {
            $sum: {
              $cond: [
                { $eq: ["$paymentStatus", "Paid"] },
                { $ifNull: ["$consultationFee", 0] },
                0,
              ],
            },
          },
        },
      },
      { $sort: { appointments: -1, _id: 1 } },
      { $limit: 6 },
    ]),
    Staff.aggregate([
      { $match: { hospitalId: hospitalObjectId } },
      {
        $group: {
          _id: "$department",
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1, _id: 1 } },
    ]),
    Appointment.find({
      hospitalId,
      appointmentDate: { $gte: startOfToday, $lte: endOfToday },
    })
      .sort({ appointmentTime: 1, createdAt: -1 })
      .limit(8)
      .lean(),
    Appointment.find({
      hospitalId,
      appointmentDate: { $gte: startOfToday },
      status: { $in: ["Scheduled", "Confirmed"] },
    })
      .sort({ appointmentDate: 1, appointmentTime: 1 })
      .limit(6)
      .lean(),
  ]);

  const [receptionistCount, nurseCount, staffCount] = await Promise.all([
    (async () => {
      const uCount = await User.countDocuments({ hospitalId, role: "Receptionist" });
      const sCount = await Staff.countDocuments({ hospitalId, role: { $regex: /^receptionist$/i } });
      return uCount + sCount;
    })(),
    (async () => {
      const uCount = await User.countDocuments({ hospitalId, role: "Nurse" });
      const sCount = await Staff.countDocuments({ hospitalId, role: { $regex: /^nurse$/i } });
      return uCount + sCount;
    })(),
    (async () => {
      const uCount = await User.countDocuments({ hospitalId, role: "Staff" });
      const sCount = await Staff.countDocuments({ hospitalId, role: { $not: /receptionist|nurse/i } });
      return uCount + sCount;
    })()
  ]);

  const { getDemoDaysRemaining } = require("../utils/hospitalAccess");
  const daysRemaining = (hospital.subscriptionType || hospital.accessType) === "demo" ? getDemoDaysRemaining(hospital) : null;

  const trendMap = new Map(
    appointmentTrendResult.map((item) => [
      `${item._id.year}-${item._id.month}`,
      { appointments: item.appointments || 0, revenue: item.revenue || 0 },
    ])
  );
  const appointmentTrend = monthAnchors.map((month) => {
    const value = trendMap.get(month.key) || { appointments: 0, revenue: 0 };
    return {
      month: month.label,
      appointments: value.appointments,
      admissions: value.appointments,
      revenue: value.revenue,
    };
  });

  const weekDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weeklyMap = new Map(weeklyAppointmentsResult.map((item) => [item._id, item.count]));
  const bedCapacity = Math.max(Number(hospital.beds) || 0, 0);
  const occupancyTrend = Array.from({ length: 7 }, (_, index) => {
    const dayOfWeek = index + 1;
    const count = weeklyMap.get(dayOfWeek) || 0;
    return {
      day: weekDays[index],
      appointments: count,
      occupancy: bedCapacity > 0 ? Math.min(100, Math.round((count / bedCapacity) * 100)) : 0,
    };
  });
  const averageOccupancy = occupancyTrend.length
    ? occupancyTrend.reduce((sum, item) => sum + item.occupancy, 0) / occupancyTrend.length
    : 0;

  const statusLabels = ["Scheduled", "Confirmed", "Completed", "Cancelled"];
  const statusMap = new Map(statusBreakdownResult.map((item) => [item._id || "Scheduled", item.count || 0]));
  const appointmentStatusBreakdown = statusLabels.map((status) => ({
    status,
    count: statusMap.get(status) || 0,
  }));

  const paymentLabels = ["Pending", "Paid"];
  const paymentMap = new Map(
    paymentBreakdownResult.map((item) => [
      item._id || "Pending",
      { count: item.count || 0, amount: item.amount || 0 },
    ])
  );
  const paymentStatusBreakdown = paymentLabels.map((status) => {
    const value = paymentMap.get(status) || { count: 0, amount: 0 };
    return {
      status,
      count: value.count,
      amount: value.amount,
    };
  });

  const departmentLoad = departmentLoadResult.map((item) => ({
    department: item._id || "Unassigned",
    appointments: item.appointments || 0,
    revenue: item.revenue || 0,
  }));

  const doctorLoad = doctorLoadResult.map((item) => ({
    doctorName: item._id || "Unassigned",
    appointments: item.appointments || 0,
    revenue: item.revenue || 0,
  }));

  const staffMix = staffMixResult.map((item) => ({
    department: item._id || "Unassigned",
    count: item.count || 0,
  }));

  res.status(200).json({
    success: true,
    data: {
      hospitalName: hospital.name || "Assigned Hospital",
      hospital: {
        id: hospital._id,
        name: hospital.name,
        city: hospital.city,
        status: hospital.status,
        type: hospital.type,
        beds: bedCapacity,
        maxDoctors: hospital.maxDoctors ?? null,
        doctors: hospital.doctors ?? 0,
        maxReceptionists: hospital.maxReceptionists ?? null,
        maxNurses: hospital.maxNurses ?? null,
        maxStaff: hospital.maxStaff ?? null,
        subscriptionType: hospital.subscriptionType || hospital.accessType || "permanent",
        subscriptionStatus: hospital.subscriptionStatus || "active",
        daysRemaining,
        doctorCount: totalDoctors,
        receptionistCount,
        nurseCount,
        staffCount,
      },
      stats: {
        totalPatients,
        totalDoctors,
        totalStaff,
        departmentCount,
        totalAppointments,
        appointmentsToday: todayAppointmentsCount,
        upcomingAppointments,
        pendingAppointments,
        confirmedAppointments,
        completedAppointments,
        cancelledAppointments,
        paidAppointments,
        pendingPayments,
        monthlyRevenue: Math.round(monthlyRevenueResult[0]?.total || 0),
        totalRevenue: Math.round(totalRevenueResult[0]?.total || 0),
        averageConsultationFee: Math.round(averageFeeResult[0]?.average || 0),
        bedCapacity,
        bedOccupancy: Math.round(averageOccupancy),
      },
      admissionTrend: appointmentTrend,
      appointmentTrend,
      occupancyTrend,
      appointmentStatusBreakdown,
      paymentStatusBreakdown,
      departmentLoad,
      doctorLoad,
      staffMix,
      appointmentsToday,
      upcomingVisits,
    },
  });
});

exports.getPatients = patientHandlers.getAll;
exports.createPatient = patientHandlers.create;
exports.updatePatient = patientHandlers.update;
exports.deletePatient = patientHandlers.remove;

exports.getDoctors = catchAsync(async (req, res) => {
  const hospitalId = getScopedHospitalId(req);
  const filter = {
    hospitalId,
    ...parseSearchFilter(req.query.search, ["firstName", "lastName", "email", "specialization", "department"]),
  };

  const data = await Doctor.find(filter).sort({ createdAt: -1 });

  res.status(200).json({
    success: true,
    total: data.length,
    data,
  });
});

exports.createDoctor = catchAsync(async (req, res, next) => {
  const hospitalId = getScopedHospitalId(req);
  const { password, ...doctorInput } = req.body;
  const normalizedEmail = normalizeDoctorEmail(doctorInput.email);

  if (!normalizedEmail) {
    return next(new AppError("Doctor email is required.", 400));
  }

  if (!password) {
    return next(new AppError("Doctor password is required.", 400));
  }

  // ─── Quota check ──────────────────────────────────────────────────────────
  const { verifyHospitalStaffLimits, createHospitalAuditLog } = require("../utils/hospitalAccess");
  try {
    await verifyHospitalStaffLimits(hospitalId, "Doctor");
  } catch (err) {
    return res.status(400).json({
      success: false,
      message: "Doctor limit reached for this hospital.",
    });
  }
  // ──────────────────────────────────────────────────────────────────────────

  const existingUser = await User.findOne({ email: normalizedEmail });
  if (existingUser) {
    return next(new AppError("A user with this doctor email already exists.", 409));
  }

  const doctorPayload = {
    ...doctorInput,
    email: normalizedEmail,
    hospitalId,
  };

  const doctorUser = await User.create({
    name: buildDoctorUserName(doctorInput),
    email: normalizedEmail,
    password,
    role: "Doctor",
    hospitalId,
    phone: doctorInput.phone || null,
  });

  try {
    const doctor = await Doctor.create({
      ...doctorPayload,
      userId: doctorUser._id,
    });

    await recordActivity({
      action: "DOCTOR_CREATED",
      entity: "Doctor",
      entityId: doctor._id,
      user: req.user,
      description: `Doctor created with login account: ${doctor.email}`,
      ip: req.ip,
      meta: { doctorUserId: doctorUser._id },
    });

    await createHospitalAuditLog(hospitalId, "Doctor Created", req.user?.email || "System");

    res.status(201).json({
      success: true,
      message: "Doctor created successfully.",
      data: doctor,
    });
  } catch (error) {
    await User.findByIdAndDelete(doctorUser._id);
    throw error;
  }
});

exports.updateDoctor = catchAsync(async (req, res, next) => {
  const hospitalId = getScopedHospitalId(req);
  const { password, ...doctorInput } = req.body;
  const doctor = await Doctor.findOne({ _id: req.params.id, hospitalId });

  if (!doctor) {
    return next(new AppError("No doctor found with that ID.", 404));
  }

  const normalizedEmail = doctorInput.email ? normalizeDoctorEmail(doctorInput.email) : doctor.email;

  if (normalizedEmail && normalizedEmail !== doctor.email) {
    const duplicateUser = await User.findOne({
      email: normalizedEmail,
      _id: { $ne: doctor.userId || null },
    });

    if (duplicateUser) {
      return next(new AppError("A user with this doctor email already exists.", 409));
    }
  }

  Object.assign(doctor, {
    ...doctorInput,
    email: normalizedEmail,
  });

  await doctor.save();

  let doctorUser = doctor.userId ? await User.findById(doctor.userId).select("+refreshToken") : null;

  if (!doctorUser) {
    if (!normalizedEmail) {
      return next(new AppError("Doctor email is required to create a login account.", 400));
    }

    if (!password) {
      return next(new AppError("Enter a password to create the doctor login account.", 400));
    }

    doctorUser = await User.create({
      name: buildDoctorUserName(doctor),
      email: normalizedEmail,
      password,
      role: "Doctor",
      hospitalId,
      phone: doctor.phone || null,
    });

    doctor.userId = doctorUser._id;
    await doctor.save();
  } else {
    doctorUser.name = buildDoctorUserName(doctor);
    doctorUser.email = normalizedEmail;
    doctorUser.phone = doctor.phone || null;
    doctorUser.hospitalId = hospitalId;

    if (password) {
      doctorUser.password = password;
      doctorUser.passwordChangedAt = new Date();
      doctorUser.refreshToken = undefined;
    }

    await doctorUser.save();
  }

  await recordActivity({
    action: "DOCTOR_UPDATED",
    entity: "Doctor",
    entityId: doctor._id,
    user: req.user,
    description: `Doctor updated: ${doctor.email || doctor._id}`,
    ip: req.ip,
    meta: { doctorUserId: doctor.userId },
  });

  res.status(200).json({
    success: true,
    message: "Doctor updated successfully.",
    data: doctor,
  });
});

exports.deleteDoctor = catchAsync(async (req, res, next) => {
  const hospitalId = getScopedHospitalId(req);
  const doctor = await Doctor.findOneAndDelete({ _id: req.params.id, hospitalId });

  if (!doctor) {
    return next(new AppError("No doctor found with that ID.", 404));
  }

  if (doctor.userId) {
    await User.findByIdAndDelete(doctor.userId);
  }

  await recordActivity({
    action: "DOCTOR_DELETED",
    entity: "Doctor",
    entityId: doctor._id,
    user: req.user,
    description: `Doctor deleted: ${doctor.email || doctor._id}`,
    ip: req.ip,
    meta: { doctorUserId: doctor.userId },
  });

  res.status(200).json({
    success: true,
    message: "Doctor deleted successfully.",
  });
});

exports.getDepartments = departmentHandlers.getAll;
exports.createDepartment = departmentHandlers.create;
exports.updateDepartment = departmentHandlers.update;
exports.deleteDepartment = departmentHandlers.remove;

exports.getStaff = staffHandlers.getAll;
exports.createStaff = catchAsync(async (req, res, next) => {
  const hospitalId = getScopedHospitalId(req);
  const { role } = req.body;
  const { verifyHospitalStaffLimits, createHospitalAuditLog } = require("../utils/hospitalAccess");

  if (role) {
    let limitRole = "Staff";
    if (/receptionist/i.test(role)) limitRole = "Receptionist";
    else if (/nurse/i.test(role)) limitRole = "Nurse";

    try {
      await verifyHospitalStaffLimits(hospitalId, limitRole);
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: err.message,
      });
    }
  }

  const doc = await Staff.create({ ...req.body, hospitalId });

  await recordActivity({
    action: "STAFF_CREATED",
    entity: "Staff",
    entityId: doc._id,
    user: req.user,
    description: "Staff created",
    ip: req.ip,
  });

  await createHospitalAuditLog(hospitalId, "Staff Created", req.user?.email || "System");

  res.status(201).json({
    success: true,
    message: "Staff created successfully.",
    data: doc,
  });
});
exports.updateStaff = staffHandlers.update;
exports.deleteStaff = staffHandlers.remove;

exports.getAppointments = appointmentHandlers.getAll;

exports.createAppointment = catchAsync(async (req, res, next) => {
  const hospitalId = getScopedHospitalId(req);
  const { doctorId, doctorName, appointmentDate, appointmentTime } = req.body;

  const mongoose = require("mongoose");
  let doctor = null;

  if (doctorId && mongoose.Types.ObjectId.isValid(doctorId)) {
    doctor = await Doctor.findOne({ _id: doctorId, hospitalId });
  }

  if (!doctor) {
    // Resolve Doctor by case-insensitive name check (stripping optional "Dr." prefixes)
    let cleanDoctorName = String(doctorName || "").trim().toLowerCase();
    if (cleanDoctorName.startsWith("dr. ")) {
      cleanDoctorName = cleanDoctorName.substring(4).trim();
    } else if (cleanDoctorName.startsWith("dr.")) {
      cleanDoctorName = cleanDoctorName.substring(3).trim();
    }
    const doctors = await Doctor.find({ hospitalId });
    doctor = doctors.find((d) => `${d.firstName} ${d.lastName}`.trim().toLowerCase() === cleanDoctorName);
  }

  if (!doctor) {
    return next(new AppError("Doctor not found with that name.", 404));
  }

  const DoctorSlot = require("../models/DoctorSlot");
  const { emitSlotsUpdated } = require("../utils/realtimeEvents");

  // Check if slot exists and is already booked
  const existingSlot = await DoctorSlot.findOne({
    hospitalId,
    doctorId: doctor._id,
    date: appointmentDate,
    slotTime: appointmentTime,
  });

  if (existingSlot && existingSlot.status === "Booked") {
    return next(new AppError("Selected slot is already booked.", 400));
  }

  // Create appointment
  const doc = await Appointment.create({ ...req.body, doctorId: doctor._id, hospitalId });

  // Update or Create the slot
  if (existingSlot) {
    existingSlot.status = "Booked";
    existingSlot.appointmentId = doc._id;
    await existingSlot.save();
  } else {
    await DoctorSlot.create({
      hospitalId,
      doctorId: doctor._id,
      date: appointmentDate,
      slotTime: appointmentTime,
      status: "Booked",
      appointmentId: doc._id,
      isActive: true,
    });
  }

  // Trigger sockets
  emitSlotsUpdated(hospitalId, doctor._id, appointmentDate);

  await recordActivity({
    action: "APPOINTMENT_CREATED",
    entity: "Appointment",
    entityId: doc._id,
    user: req.user,
    description: "Appointment created",
    ip: req.ip,
  });

  // Call afterCreate logic
  if (doc.patientUserId) {
    const { emitToPatient, EVENTS } = require("../utils/realtimeEvents");
    emitToPatient(doc.patientUserId, EVENTS.APPOINTMENT_CREATED, doc.toObject());
  }
  const { emitToHospitalRole, EVENTS } = require("../utils/realtimeEvents");
  emitToHospitalRole(hospitalId, "Receptionist", EVENTS.APPOINTMENT_CREATED, doc.toObject());
  emitToHospitalRole(hospitalId, "Hospital Admin", EVENTS.APPOINTMENT_CREATED, doc.toObject());

  res.status(201).json({
    success: true,
    message: "Appointment created successfully.",
    data: doc,
  });
});

exports.updateAppointment = catchAsync(async (req, res, next) => {
  const hospitalId = getScopedHospitalId(req);
  const appointmentId = req.params.id;

  const previousDoc = await Appointment.findOne({ _id: appointmentId, hospitalId }).lean();
  if (!previousDoc) {
    return next(new AppError("No appointment found with that ID.", 404));
  }

  const { doctorName, appointmentDate, appointmentTime } = req.body;

  // Resolve Doctor
  let doctorId = previousDoc.doctorId;
  if (doctorName && doctorName !== previousDoc.doctorName) {
    const cleanDoctorName = String(doctorName).trim().toLowerCase();
    const doctors = await Doctor.find({ hospitalId });
    const doctor = doctors.find((d) => `${d.firstName} ${d.lastName}`.trim().toLowerCase() === cleanDoctorName);
    if (!doctor) {
      return next(new AppError("Doctor not found with that name.", 404));
    }
    doctorId = doctor._id;
  }

  const DoctorSlot = require("../models/DoctorSlot");
  const { emitSlotsUpdated } = require("../utils/realtimeEvents");

  // Check if slot changed
  const oldDate = previousDoc.appointmentDate.toISOString().split("T")[0];
  const oldTime = previousDoc.appointmentTime;
  const newDate = appointmentDate || oldDate;
  const newTime = appointmentTime || oldTime;
  const slotChanged = oldDate !== newDate || oldTime !== newTime || String(doctorId) !== String(previousDoc.doctorId);

  if (slotChanged) {
    // Check if new slot is booked
    const newSlot = await DoctorSlot.findOne({
      hospitalId,
      doctorId,
      date: newDate,
      slotTime: newTime,
    });
    if (newSlot && newSlot.status === "Booked" && String(newSlot.appointmentId) !== String(appointmentId)) {
      return next(new AppError("Selected slot is already booked.", 400));
    }

    // Free up old slot
    await DoctorSlot.findOneAndUpdate(
      { appointmentId },
      { status: "Available", appointmentId: null }
    );

    // Book new slot
    if (newSlot) {
      newSlot.status = "Booked";
      newSlot.appointmentId = appointmentId;
      await newSlot.save();
    } else {
      await DoctorSlot.create({
        hospitalId,
        doctorId,
        date: newDate,
        slotTime: newTime,
        status: "Booked",
        appointmentId,
        isActive: true,
      });
    }
  }

  // Update appointment
  const doc = await Appointment.findOneAndUpdate(
    { _id: appointmentId, hospitalId },
    { ...req.body, doctorId },
    { new: true, runValidators: true }
  );

  if (!doc) {
    return next(new AppError("No appointment found with that ID.", 404));
  }

  // Real-time events
  if (slotChanged) {
    emitSlotsUpdated(hospitalId, previousDoc.doctorId, oldDate);
    emitSlotsUpdated(hospitalId, doctorId, newDate);
  }

  await recordActivity({
    action: "APPOINTMENT_UPDATED",
    entity: "Appointment",
    entityId: doc._id,
    user: req.user,
    description: "Appointment updated",
    ip: req.ip,
  });

  // Call afterUpdate hooks
  await deleteAppointmentNotifications(doc._id);
  const statusChanged = req.body.status && req.body.status !== previousDoc.status;
  if (statusChanged && doc.patientUserId) {
    await createPatientAppointmentStatusNotification(doc, req.body.status);
  }

  const { emitToPatient, emitToHospitalRole, EVENTS } = require("../utils/realtimeEvents");
  const event = req.body.status === "Cancelled" ? EVENTS.APPOINTMENT_CANCELLED : EVENTS.APPOINTMENT_UPDATED;
  if (doc.patientUserId) {
    emitToPatient(doc.patientUserId, event, doc.toObject());
  }
  emitToHospitalRole(hospitalId, "Receptionist", EVENTS.APPOINTMENT_UPDATED, doc.toObject());
  emitToHospitalRole(hospitalId, "Hospital Admin", EVENTS.APPOINTMENT_UPDATED, doc.toObject());

  res.status(200).json({
    success: true,
    message: "Appointment updated successfully.",
    data: doc,
  });
});

exports.deleteAppointment = catchAsync(async (req, res, next) => {
  const hospitalId = getScopedHospitalId(req);
  const appointmentId = req.params.id;

  const doc = await Appointment.findOneAndDelete({ _id: appointmentId, hospitalId });
  if (!doc) {
    return next(new AppError("No appointment found with that ID.", 404));
  }

  // Free up slot
  const DoctorSlot = require("../models/DoctorSlot");
  const { emitSlotsUpdated } = require("../utils/realtimeEvents");
  const slot = await DoctorSlot.findOneAndUpdate(
    { appointmentId },
    { status: "Available", appointmentId: null },
    { new: true }
  );

  if (slot) {
    emitSlotsUpdated(hospitalId, doc.doctorId, slot.date);
  }

  await recordActivity({
    action: "APPOINTMENT_DELETED",
    entity: "Appointment",
    entityId: doc._id,
    user: req.user,
    description: "Appointment deleted",
    ip: req.ip,
  });

  // Call afterRemove hooks
  await deleteAppointmentNotifications(doc._id);
  const { emitToPatient, emitToHospitalRole, EVENTS } = require("../utils/realtimeEvents");
  if (doc.patientUserId) {
    emitToPatient(doc.patientUserId, EVENTS.APPOINTMENT_CANCELLED, doc.toObject());
  }
  emitToHospitalRole(hospitalId, "Receptionist", EVENTS.APPOINTMENT_CANCELLED, doc.toObject());
  emitToHospitalRole(hospitalId, "Hospital Admin", EVENTS.APPOINTMENT_CANCELLED, doc.toObject());

  res.status(200).json({
    success: true,
    message: "Appointment deleted successfully.",
  });
});

exports.updateAppointmentPayment = catchAsync(async (req, res, next) => {
  const hospitalId = getScopedHospitalId(req);
  const { amount, method, paymentStatus } = req.body;

  const appointment = await Appointment.findOneAndUpdate(
    { _id: req.params.id, hospitalId },
    {
      consultationFee: amount,
      paymentMethod: method,
      paymentStatus,
    },
    { new: true, runValidators: true }
  );

  if (!appointment) return next(new AppError("No appointment found with that ID.", 404));

  await recordActivity({
    action: "APPOINTMENT_PAYMENT_UPDATED",
    entity: "Appointment",
    entityId: appointment._id,
    user: req.user,
    description: "Appointment payment updated",
    ip: req.ip,
  });

  await deleteAppointmentNotifications(appointment._id);

  res.status(200).json({
    success: true,
    message: "Appointment payment updated successfully.",
    data: appointment,
  });
});
