const User = require("../models/User");
const Hospital = require("../models/Hospital");
const Activity = require("../models/Activity");
const PatientUser = require("../models/PatientUser");
const catchAsync = require("../utils/catchAsync");
const AppError = require("../utils/AppError");
const { sendCSV } = require("../utils/csvExport");

// ─── GET /api/v1/reports?type=users|hospitals|activity ───────────────────────
exports.getReport = catchAsync(async (req, res, next) => {
  const { type, format } = req.query;

  if (!type) return next(new AppError("Query param 'type' is required.", 400));

  switch (type) {
    case "users":
      return getUsersReport(req, res, format);
    case "hospitals":
      return getHospitalsReport(req, res, format);
    case "activity":
      return getActivityReport(req, res, format);
    default:
      return next(new AppError("Invalid report type. Use: users | hospitals | activity", 400));
  }
});

// ─── Users Report ─────────────────────────────────────────────────────────────
const getUsersReport = async (req, res, format) => {
  const [
    totalStaff,
    activeStaff,
    inactiveStaff,
    onLeaveStaff,
    totalPatients,
    staffUsersByRole,
    recentStaff,
    recentPatients,
    staffMonthlySignups,
    patientMonthlySignups,
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ status: "Active" }),
    User.countDocuments({ status: "Inactive" }),
    User.countDocuments({ status: "On Leave" }),
    PatientUser.countDocuments(),
    User.aggregate([
      { $group: { _id: "$role", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    User.find()
      .select("name email role status lastLogin createdAt")
      .sort({ createdAt: -1 })
      .limit(10),
    PatientUser.find()
      .select("name email status lastLogin createdAt")
      .sort({ createdAt: -1 })
      .limit(10),
    User.aggregate([
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": -1, "_id.month": -1 } },
      { $limit: 12 },
    ]),
    PatientUser.aggregate([
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": -1, "_id.month": -1 } },
      { $limit: 12 },
    ]),
  ]);

  const totalUsers = totalStaff + totalPatients;
  const activeUsers = activeStaff + totalPatients;
  const usersByRole = [
    ...staffUsersByRole,
    ...(totalPatients > 0 ? [{ _id: "Patient", count: totalPatients }] : []),
  ].sort((left, right) => right.count - left.count);

  const monthlySignupsMap = new Map();
  staffMonthlySignups.forEach((entry) => {
    const key = `${entry._id.year}-${String(entry._id.month).padStart(2, "0")}`;
    monthlySignupsMap.set(key, (monthlySignupsMap.get(key) || 0) + entry.count);
  });
  patientMonthlySignups.forEach((entry) => {
    const key = `${entry._id.year}-${String(entry._id.month).padStart(2, "0")}`;
    monthlySignupsMap.set(key, (monthlySignupsMap.get(key) || 0) + entry.count);
  });

  const monthlySignups = Array.from(monthlySignupsMap.entries())
    .map(([key, count]) => {
      const [year, month] = key.split("-");
      return { _id: { year: Number(year), month: Number(month) }, count };
    })
    .sort((left, right) => {
      if (left._id.year !== right._id.year) return right._id.year - left._id.year;
      return right._id.month - left._id.month;
    })
    .slice(0, 12);

  const recentUsers = [...recentStaff, ...recentPatients.map((patient) => ({
    ...patient.toObject(),
    role: "Patient",
  }))]
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
    .slice(0, 10);

  if (format === "csv") {
    const csvData = recentUsers.map((u) => ({
      Name: u.name,
      Email: u.email,
      Role: u.role,
      Status: u.status,
      LastLogin: u.lastLogin || "Never",
      CreatedAt: u.createdAt?.toISOString().split("T")[0],
    }));
    return sendCSV(
      res,
      csvData,
      ["Name", "Email", "Role", "Status", "LastLogin", "CreatedAt"],
      "users-report"
    );
  }

  res.status(200).json({
    success: true,
    type: "users",
    summary: {
      totalUsers,
      totalStaff,
      totalPatients,
      activeUsers,
      activeStaff,
      inactiveUsers: inactiveStaff,
      onLeaveUsers: onLeaveStaff,
      activePercentage:
        totalUsers > 0 ? Math.round((activeUsers / totalUsers) * 100) : 0,
    },
    usersByRole,
    monthlySignups,
    recentUsers,
  });
};

// ─── Hospitals Report ─────────────────────────────────────────────────────────
const getHospitalsReport = async (req, res, format) => {
  const [
    totalHospitals,
    activeHospitals,
    inactiveHospitals,
    hospitalsByCity,
    hospitalsByType,
    totalBeds,
    recentHospitals,
  ] = await Promise.all([
    Hospital.countDocuments(),
    Hospital.countDocuments({ status: "Active" }),
    Hospital.countDocuments({ status: "Inactive" }),
    Hospital.aggregate([
      { $group: { _id: "$city", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
    Hospital.aggregate([
      { $group: { _id: "$type", count: { $sum: 1 } } },
    ]),
    Hospital.aggregate([
      { $group: { _id: null, totalBeds: { $sum: "$beds" }, totalDoctors: { $sum: "$doctors" } } },
    ]),
    Hospital.find()
      .select("name city beds doctors status type createdAt")
      .sort({ createdAt: -1 })
      .limit(10),
  ]);

  if (format === "csv") {
    const csvData = recentHospitals.map((h) => ({
      Name: h.name,
      City: h.city,
      Beds: h.beds,
      Doctors: h.doctors,
      Status: h.status,
      Type: h.type,
      CreatedAt: h.createdAt?.toISOString().split("T")[0],
    }));
    return sendCSV(
      res,
      csvData,
      ["Name", "City", "Beds", "Doctors", "Status", "Type", "CreatedAt"],
      "hospitals-report"
    );
  }

  res.status(200).json({
    success: true,
    type: "hospitals",
    summary: {
      totalHospitals,
      activeHospitals,
      inactiveHospitals,
      totalBeds: totalBeds[0]?.totalBeds || 0,
      totalDoctors: totalBeds[0]?.totalDoctors || 0,
    },
    hospitalsByCity,
    hospitalsByType,
    recentHospitals,
  });
};

// ─── Activity Report ──────────────────────────────────────────────────────────
const getActivityReport = async (req, res, format) => {
  const days = parseInt(req.query.days) || 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [
    totalEvents,
    eventsByAction,
    eventsByEntity,
    recentEvents,
    dailyActivity,
  ] = await Promise.all([
    Activity.countDocuments({ createdAt: { $gte: since } }),
    Activity.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: "$action", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 15 },
    ]),
    Activity.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: "$entity", count: { $sum: 1 } } },
    ]),
    Activity.find({ createdAt: { $gte: since } })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate("userId", "name email role"),
    Activity.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  if (format === "csv") {
    const csvData = recentEvents.map((e) => ({
      Action: e.action,
      Entity: e.entity,
      User: e.userName || "System",
      Description: e.description,
      IP: e.ip || "N/A",
      Timestamp: e.createdAt?.toISOString(),
    }));
    return sendCSV(
      res,
      csvData,
      ["Action", "Entity", "User", "Description", "IP", "Timestamp"],
      "activity-report"
    );
  }

  res.status(200).json({
    success: true,
    type: "activity",
    period: `Last ${days} days`,
    summary: { totalEvents },
    eventsByAction,
    eventsByEntity,
    dailyActivity,
    recentEvents,
  });
};

// ─── GET /api/v1/reports/overview ─────────────────────────────────────────────
exports.getDashboardOverview = catchAsync(async (req, res, next) => {
  const [
    totalUsers,
    activeUsers,
    totalPatients,
    activePatients,
    totalHospitals,
    activeHospitals,
    recentActivity,
    userGrowth,
    staffUsersByRole,
    patientGrowth,
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ status: "Active" }),
    PatientUser.countDocuments(),
    PatientUser.countDocuments(),
    Hospital.countDocuments(),
    Hospital.countDocuments({ status: "Active" }),
    Activity.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .populate("userId", "name role"),
    User.aggregate([
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: -1 } },
      { $limit: 6 },
    ]),
    User.aggregate([
      { $group: { _id: "$role", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    PatientUser.aggregate([
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: -1 } },
      { $limit: 6 },
    ]),
  ]);

  const usersByRole = [
    ...staffUsersByRole,
    ...(totalPatients > 0 ? [{ _id: "Patient", count: totalPatients }] : []),
  ].sort((left, right) => right.count - left.count);

  const combinedGrowthMap = new Map();
  userGrowth.forEach((entry) => {
    combinedGrowthMap.set(entry._id, (combinedGrowthMap.get(entry._id) || 0) + entry.count);
  });
  patientGrowth.forEach((entry) => {
    combinedGrowthMap.set(entry._id, (combinedGrowthMap.get(entry._id) || 0) + entry.count);
  });

  const combinedUserGrowth = Array.from(combinedGrowthMap.entries())
    .map(([_id, count]) => ({ _id, count }))
    .sort((left, right) => left._id.localeCompare(right._id))
    .slice(-6);

  res.status(200).json({
    success: true,
    data: {
      totalUsers: totalUsers + totalPatients,
      activeUsers: activeUsers + activePatients,
      totalStaffUsers: totalUsers,
      activeStaffUsers: activeUsers,
      totalPatients,
      activePatients,
      totalHospitals,
      activeHospitals,
      recentActivity,
      userGrowth: combinedUserGrowth,
      usersByRole,
    },
  });
});
