const User = require("../models/User");
const Hospital = require("../models/Hospital");
const PatientUser = require("../models/PatientUser");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const recordActivity = require("../utils/recordActivity");
const { applyDemoAccessToHospital, createHospitalAuditLog, verifyHospitalStaffLimits } = require("../utils/hospitalAccess");

const buildFilter = (query) => {
  const filter = {};
  if (query.role) filter.role = query.role;
  if (query.status) filter.status = query.status;
  if (query.search) {
    filter.$or = [
      { name: { $regex: query.search, $options: "i" } },
      { email: { $regex: query.search, $options: "i" } },
    ];
  }
  return filter;
};

const creatableAccountRoles = ["Hospital Admin", "Receptionist"];
const hospitalScopedAccountRoles = ["Hospital Admin", "Receptionist"];

const assertCreatableAccountRole = (role) => {
  if (!creatableAccountRoles.includes(role)) {
    throw new AppError(
      "Only Hospital Admin and Receptionist accounts can be created from System Users.",
      403
    );
  }
};

const validateHospitalScopedAssignment = async ({ userId = null, role, hospitalId }) => {
  if (!hospitalScopedAccountRoles.includes(role)) return null;

  if (!hospitalId) {
    throw new AppError(`${role} must be assigned to a hospital.`, 400);
  }

  const hospital = await Hospital.findById(hospitalId);
  if (!hospital) {
    throw new AppError("Selected hospital was not found.", 404);
  }

  if (
    role === "Hospital Admin" &&
    hospital.adminId &&
    hospital.adminId.toString() !== userId?.toString()
  ) {
    throw new AppError(
      "This hospital already has an assigned Hospital Admin. Update the existing admin instead.",
      409
    );
  }

  return hospital;
};

const syncHospitalAdminAssignment = async (previousUser, updatedUser) => {
  if (previousUser?.role === "Hospital Admin" && previousUser.hospitalId) {
    await Hospital.findOneAndUpdate(
      { _id: previousUser.hospitalId, adminId: previousUser._id },
      { adminId: null }
    );
  }

  if (updatedUser?.role === "Hospital Admin" && updatedUser.hospitalId) {
    await Hospital.findByIdAndUpdate(updatedUser.hospitalId, { adminId: updatedUser._id });
  }
};

const mapPatientAsUserRecord = (patient) => ({
  _id: patient._id,
  id: String(patient._id),
  name: patient.name,
  email: patient.email,
  phone: patient.phone,
  role: "Patient",
  status: "Active",
  reportCredits: patient.reportCredits || 0,
  prescriptionCredits: patient.prescriptionCredits || 0,
  lastLogin: patient.lastLogin || null,
  hospitalId: null,
  accountType: "patient",
  createdAt: patient.createdAt,
});

exports.getAllUsers = catchAsync(async (req, res, next) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;
  const sortBy = req.query.sortBy || "createdAt";
  const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;
  const includePatients = req.query.includePatients !== "false";
  const roleFilter = req.query.role;

  if (roleFilter === "Patient") {
    const patientFilter = {};
    if (req.query.search) {
      patientFilter.$or = [
        { name: { $regex: req.query.search, $options: "i" } },
        { email: { $regex: req.query.search, $options: "i" } },
        { phone: { $regex: req.query.search, $options: "i" } },
      ];
    }

    const [patients, total] = await Promise.all([
      PatientUser.find(patientFilter)
        .select("name email phone reportCredits prescriptionCredits lastLogin createdAt")
        .sort({ [sortBy === "name" ? "name" : "createdAt"]: sortOrder })
        .skip(skip)
        .limit(limit),
      PatientUser.countDocuments(patientFilter),
    ]);

    return res.status(200).json({
      success: true,
      total,
      page,
      pages: Math.ceil(total / limit),
      limit,
      data: patients.map(mapPatientAsUserRecord),
    });
  }

  const filter = buildFilter(req.query);

  const [users, userTotal, patients] = await Promise.all([
    User.find(filter)
      .select("-password -refreshToken")
      .sort({ [sortBy]: sortOrder })
      .populate("hospitalId", "name city hospitalCode adminId accessType demoExpiresAt status"),
    User.countDocuments(filter),
    includePatients && !roleFilter
      ? PatientUser.find(
          req.query.search
            ? {
                $or: [
                  { name: { $regex: req.query.search, $options: "i" } },
                  { email: { $regex: req.query.search, $options: "i" } },
                  { phone: { $regex: req.query.search, $options: "i" } },
                ],
              }
            : {}
        )
          .select("name email phone reportCredits prescriptionCredits lastLogin createdAt")
          .sort({ createdAt: -1 })
          .limit(500)
      : Promise.resolve([]),
  ]);

  const staffRecords = users.map((user) => ({
    ...(user.toObject ? user.toObject() : user),
    accountType: "staff",
  }));

  const mergedRecords = includePatients && !roleFilter
    ? [...staffRecords, ...patients.map(mapPatientAsUserRecord)].sort((left, right) => {
        const leftTime = new Date(left.createdAt || 0).getTime();
        const rightTime = new Date(right.createdAt || 0).getTime();
        return sortOrder === 1 ? leftTime - rightTime : rightTime - leftTime;
      })
    : staffRecords;

  const total = includePatients && !roleFilter ? userTotal + patients.length : userTotal;
  const paginated = mergedRecords.slice(skip, skip + limit);

  res.status(200).json({
    success: true,
    total,
    page,
    pages: Math.ceil(total / limit) || 1,
    limit,
    data: paginated,
  });
});

exports.createUser = catchAsync(async (req, res, next) => {
  const { name, email, password, role, status, hospitalId, phone, accessType, demoDays } = req.body;
  const assignedRole = role || "Hospital Admin";

  const existing = await User.findOne({ email });
  if (existing) return next(new AppError("A user with this email already exists.", 409));

  assertCreatableAccountRole(assignedRole);
  await validateHospitalScopedAssignment({ role: assignedRole, hospitalId });

  if (hospitalId && ["Doctor", "Receptionist", "Nurse", "Staff"].includes(assignedRole)) {
    try {
      await verifyHospitalStaffLimits(hospitalId, assignedRole);
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: err.message,
      });
    }
  }

  const user = await User.create({ name, email, password, role: assignedRole, status, hospitalId, phone });
  await syncHospitalAdminAssignment(null, user);

  if (hospitalId) {
    await createHospitalAuditLog(hospitalId, `User Created (${assignedRole})`, req.user?.email || "System");
  }

  if (assignedRole === "Hospital Admin" && hospitalId) {
    await applyDemoAccessToHospital({
      hospitalId,
      accessType: accessType === "demo" ? "demo" : "permanent",
      demoDays,
      performedBy: req.user?.email || "System",
    });
  }

  await recordActivity({
    action: "USER_CREATED",
    entity: "User",
    entityId: user._id,
    user: req.user,
    description: `User created: ${user.email} (${user.role})`,
    ip: req.ip,
    meta: { targetUserId: user._id, role: user.role },
  });

  res.status(201).json({
    success: true,
    message: "User created successfully.",
    data: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      hospitalId: user.hospitalId,
    },
  });
});

exports.getUserById = catchAsync(async (req, res, next) => {
  const user = await User.findById(req.params.id)
    .select("-password -refreshToken")
    .populate("hospitalId", "name city hospitalCode adminId");

  if (!user) return next(new AppError("No user found with that ID.", 404));

  res.status(200).json({ success: true, data: user });
});

exports.updateUser = catchAsync(async (req, res, next) => {
  const { password, refreshToken, accessType, demoDays, ...updateData } = req.body;

  if (req.user.role !== "Super Admin") delete updateData.role;

  if (typeof updateData.email === "string") {
    updateData.email = updateData.email.trim().toLowerCase();
  }

  const existingUser = await User.findById(req.params.id);
  if (!existingUser) return next(new AppError("No user found with that ID.", 404));

  // Super Admin accounts are protected:
  // - Their role cannot be changed (no demotion).
  // - Their status cannot be set to Inactive or Suspended.
  if (existingUser.role === "Super Admin") {
    if (updateData.role && updateData.role !== "Super Admin") {
      return next(new AppError("Super Admin role cannot be changed.", 403));
    }
    if (updateData.status && ["Inactive", "Suspended"].includes(updateData.status)) {
      return next(new AppError("Super Admin accounts cannot be deactivated.", 403));
    }
  }

  const previousUser = {
    _id: existingUser._id,
    role: existingUser.role,
    hospitalId: existingUser.hospitalId,
  };


  if (
    updateData.email &&
    updateData.email !== existingUser.email
  ) {
    const duplicateUser = await User.findOne({ email: updateData.email });
    if (duplicateUser) {
      return next(new AppError("A user with this email already exists.", 409));
    }
  }

  const nextRole = updateData.role ?? existingUser.role;
  const nextHospitalId = updateData.hospitalId ?? existingUser.hospitalId;

  if (updateData.role && updateData.role !== existingUser.role) {
    assertCreatableAccountRole(updateData.role);
  }

  await validateHospitalScopedAssignment({
    userId: existingUser._id,
    role: nextRole,
    hospitalId: nextHospitalId,
  });

  Object.assign(existingUser, updateData);

  if (password) {
    existingUser.password = password;
    existingUser.passwordChangedAt = new Date();
    existingUser.refreshToken = undefined;
  }

  await existingUser.save();

  const user = await User.findById(existingUser._id)
    .select("-password -refreshToken");

  await syncHospitalAdminAssignment(previousUser, user);

  if (
    user.role === "Hospital Admin" &&
    user.hospitalId &&
    req.user.role === "Super Admin" &&
    (accessType || demoDays !== undefined || updateData.status === "Active")
  ) {
    if (accessType === "demo" || accessType === "permanent") {
      await applyDemoAccessToHospital({
        hospitalId: user.hospitalId,
        accessType,
        demoDays,
      });
    } else if (updateData.status === "Active") {
      await Hospital.findByIdAndUpdate(user.hospitalId, { status: "Active" });
    }
  }

  await recordActivity({
    action: "USER_UPDATED",
    entity: "User",
    entityId: user._id,
    user: req.user,
    description: `User updated: ${user.email}`,
    ip: req.ip,
    meta: { fields: [...Object.keys(updateData), ...(password ? ["password"] : [])] },
  });

  res.status(200).json({
    success: true,
    message: "User updated successfully.",
    data: user,
  });
});

exports.deleteUser = catchAsync(async (req, res, next) => {
  if (req.params.id === req.user._id.toString()) {
    return next(new AppError("You cannot delete your own account.", 400));
  }

  // Super Admin accounts are protected — no one can delete them.
  const targetUser = await User.findById(req.params.id);
  if (targetUser?.role === "Super Admin") {
    return next(new AppError("Super Admin accounts cannot be deleted.", 403));
  }

  // Invalidate the active session before deleting so the browser-side
  // cookie becomes orphaned and the 401 flow logs them out cleanly.
  await User.findByIdAndUpdate(req.params.id, { refreshToken: null });

  const user = await User.findByIdAndDelete(req.params.id);
  if (!user) return next(new AppError("No user found with that ID.", 404));

  if (user.role === "Hospital Admin" && user.hospitalId) {
    await Hospital.findOneAndUpdate(
      { _id: user.hospitalId, adminId: user._id },
      { adminId: null }
    );
  }

  await recordActivity({
    action: "USER_DELETED",
    entity: "User",
    entityId: user._id,
    user: req.user,
    description: `User deleted: ${user.email} (${user.role})`,
    ip: req.ip,
  });

  res.status(200).json({
    success: true,
    message: "User deleted successfully.",
  });
});

exports.toggleUserStatus = catchAsync(async (req, res, next) => {
  const existing = await User.findById(req.params.id);
  if (!existing) return next(new AppError("No user found with that ID.", 404));

  // Super Admin accounts are protected — their status cannot be changed.
  if (existing.role === "Super Admin") {
    return next(new AppError("Super Admin accounts cannot be deactivated.", 403));
  }

  const newStatus = existing.status === "Active" ? "Inactive" : "Active";

  // Build the update atomically:
  // When deactivating → also null-out refreshToken so the active session
  // expires on next refresh attempt (DB mismatch → 401 → logout on frontend).
  const updateFields = { status: newStatus };
  if (newStatus === "Inactive") {
    updateFields.refreshToken = null;
  }

  const user = await User.findByIdAndUpdate(
    req.params.id,
    { $set: updateFields },
    { new: true, runValidators: false }
  );

  await recordActivity({
    action: "USER_STATUS_TOGGLED",
    entity: "User",
    entityId: user._id,
    user: req.user,
    description: `User ${user.email} status changed to ${newStatus}`,
    ip: req.ip,
  });

  res.status(200).json({
    success: true,
    message: `User status updated to ${newStatus}.`,
    data: { id: user._id, status: newStatus },
  });
});

// ─── Patient Admin Controllers ───────────────────────────────────────────────
exports.getPatientCredits = catchAsync(async (req, res, next) => {
  const patient = await PatientUser.findById(req.params.id);
  if (!patient) {
    return next(new AppError("Patient not found", 404));
  }
  const CreditTransaction = require("../models/CreditTransaction");
  const transactions = await CreditTransaction.find({ userId: patient._id }).sort({ createdAt: -1 });
  res.status(200).json({
    success: true,
    data: {
      reportCredits: patient.reportCredits || 0,
      prescriptionCredits: patient.prescriptionCredits || 0,
      transactions
    }
  });
});

exports.adjustPatientCredits = catchAsync(async (req, res, next) => {
  const { creditType, action, amount, reason } = req.body;
  if (!creditType || !["report", "prescription"].includes(creditType)) {
    return next(new AppError("Invalid or missing creditType. Must be 'report' or 'prescription'.", 400));
  }
  if (!action || !["add", "deduct", "reset"].includes(action)) {
    return next(new AppError("Invalid or missing action. Must be 'add', 'deduct', or 'reset'.", 400));
  }
  if (action !== "reset" && (!amount || typeof amount !== "number" || amount <= 0)) {
    return next(new AppError("Amount must be a positive number.", 400));
  }
  if (!reason || typeof reason !== "string" || reason.trim() === "") {
    return next(new AppError("A reason is required for audit trail.", 400));
  }

  const patient = await PatientUser.findById(req.params.id);
  if (!patient) {
    return next(new AppError("Patient not found", 404));
  }

  const CreditTransaction = require("../models/CreditTransaction");
  let finalAmount = amount || 0;
  let originalCredits = creditType === "report" ? (patient.reportCredits || 0) : (patient.prescriptionCredits || 0);
  let newCredits = originalCredits;

  if (action === "add") {
    newCredits += finalAmount;
  } else if (action === "deduct") {
    if (originalCredits < finalAmount) {
      return next(new AppError(`Insufficient credits. Patient only has ${originalCredits} ${creditType} credits.`, 400));
    }
    newCredits -= finalAmount;
  } else if (action === "reset") {
    newCredits = 0;
    finalAmount = originalCredits;
  }

  if (creditType === "report") {
    patient.reportCredits = newCredits;
  } else {
    patient.prescriptionCredits = newCredits;
  }
  await patient.save({ validateBeforeSave: false });

  // Log transaction
  if (action === "reset") {
    if (originalCredits > 0) {
      await CreditTransaction.create({
        userId: patient._id,
        creditType,
        type: "consumption",
        amount: originalCredits,
        reason: reason.trim(),
        performedBy: "admin",
        adminUserId: req.user._id,
      });
    }
  } else {
    const transactionType = action === "add" ? "addition" : "consumption";
    await CreditTransaction.create({
      userId: patient._id,
      creditType,
      type: transactionType,
      amount: finalAmount,
      reason: reason.trim(),
      performedBy: "admin",
      adminUserId: req.user._id,
    });
  }

  // Record activity
  await recordActivity({
    action: "PATIENT_CREDITS_ADJUSTED",
    entity: "PatientUser",
    entityId: patient._id,
    user: req.user,
    description: `Adjusted patient ${patient.email} ${creditType} credits (${action}, amount: ${finalAmount}, reason: ${reason}).`,
    ip: req.ip,
  });

  // Emit real-time socket update to the patient
  try {
    const { emitToPatient, EVENTS } = require("../utils/realtimeEvents");
    const payload = {
      reportCredits: patient.reportCredits,
      prescriptionCredits: patient.prescriptionCredits,
    };
    const payloadType = action === "add" ? "increase" : (action === "deduct" || action === "reset" ? "decrease" : null);
    if (payloadType) {
      payload.creditUpdated = {
        type: payloadType,
        amount: finalAmount,
        creditType: creditType,
        reason: reason.trim(),
      };
    }
    console.log('[Socket Debug] adjustPatientCredits emitting profile:updated for patient:', patient._id, 'payload:', JSON.stringify(payload));
    emitToPatient(patient._id, EVENTS.PROFILE_UPDATED, payload);
  } catch (socketErr) {
    console.error("Failed to emit profile:updated socket event:", socketErr);
  }


  res.status(200).json({
    success: true,
    message: `Successfully adjusted credits.`,
    data: {
      reportCredits: patient.reportCredits,
      prescriptionCredits: patient.prescriptionCredits,
    }
  });
});

exports.getPatientSessions = catchAsync(async (req, res, next) => {
  const patient = await PatientUser.findById(req.params.id);
  if (!patient) {
    return next(new AppError("Patient not found", 404));
  }
  const PatientSession = require("../models/PatientSession");
  const sessions = await PatientSession.find({ userId: patient._id }).sort({ lastActive: -1 });
  res.status(200).json({
    success: true,
    data: sessions
  });
});

exports.terminatePatientSession = catchAsync(async (req, res, next) => {
  const patient = await PatientUser.findById(req.params.id);
  if (!patient) {
    return next(new AppError("Patient not found", 404));
  }

  const PatientSession = require("../models/PatientSession");
  const session = await PatientSession.findOne({
    userId: patient._id,
    _id: req.params.sessionId,
  });

  if (!session) {
    return next(new AppError("Session not found", 404));
  }

  await PatientSession.deleteOne({ _id: session._id });

  // Send system notification
  const NotificationLog = require("../models/NotificationLog");
  try {
    await NotificationLog.create({
      patientUserId: patient._id,
      title: "Device Session Terminated",
      body: `Your session on device '${session.deviceName}' was terminated by an administrator.`,
      status: "sent",
      category: "system",
      actionUrl: "/dashboard",
    });
  } catch (err) {
    console.error("Failed to create termination notification:", err);
  }

  // Record audit activity
  await recordActivity({
    action: "PATIENT_SESSION_REMOVED_BY_ADMIN",
    entity: "PatientUser",
    entityId: patient._id,
    user: req.user,
    description: `Session on device '${session.deviceName}' (${session.deviceId}) was terminated by admin.`,
    ip: req.ip,
  });

  res.status(200).json({
    success: true,
    message: "Session terminated successfully."
  });
});

exports.bulkAdjustPatientCredits = catchAsync(async (req, res, next) => {
  const { userIds, allPatients, creditType, action, amount, reason } = req.body;

  if (!creditType || !["report", "prescription"].includes(creditType)) {
    return next(new AppError("Invalid or missing creditType. Must be 'report' or 'prescription'.", 400));
  }
  if (!action || !["add", "deduct", "reset"].includes(action)) {
    return next(new AppError("Invalid or missing action. Must be 'add', 'deduct', or 'reset'.", 400));
  }
  if (action !== "reset" && (!amount || typeof amount !== "number" || amount <= 0)) {
    return next(new AppError("Amount must be a positive number.", 400));
  }
  if (!reason || typeof reason !== "string" || reason.trim() === "") {
    return next(new AppError("A reason is required for audit trail.", 400));
  }

  let query = {};
  if (allPatients === true) {
    query = {};
  } else {
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return next(new AppError("Must specify userIds or set allPatients to true.", 400));
    }
    query = { _id: { $in: userIds } };
  }

  const patients = await PatientUser.find(query);
  if (patients.length === 0) {
    return res.status(200).json({
      success: true,
      message: "No patients found to update.",
      updatedCount: 0
    });
  }

  const CreditTransaction = require("../models/CreditTransaction");
  let updatedCount = 0;

  const updatePromises = patients.map(async (patient) => {
    let finalAmount = amount || 0;
    let originalCredits = creditType === "report" ? (patient.reportCredits || 0) : (patient.prescriptionCredits || 0);
    let newCredits = originalCredits;

    if (action === "add") {
      newCredits += finalAmount;
    } else if (action === "deduct") {
      finalAmount = Math.min(originalCredits, finalAmount);
      newCredits -= finalAmount;
    } else if (action === "reset") {
      newCredits = 0;
      finalAmount = originalCredits;
    }

    if (newCredits === originalCredits && action !== "reset") {
      return;
    }

    if (creditType === "report") {
      patient.reportCredits = newCredits;
    } else {
      patient.prescriptionCredits = newCredits;
    }
    await patient.save({ validateBeforeSave: false });
    updatedCount++;

    // Log transaction
    if (action === "reset") {
      if (originalCredits > 0) {
        await CreditTransaction.create({
          userId: patient._id,
          creditType,
          type: "consumption",
          amount: originalCredits,
          reason: reason.trim(),
          performedBy: "admin",
          adminUserId: req.user._id,
        });
      }
    } else {
      if (finalAmount > 0) {
        const transactionType = action === "add" ? "addition" : "consumption";
        await CreditTransaction.create({
          userId: patient._id,
          creditType,
          type: transactionType,
          amount: finalAmount,
          reason: reason.trim(),
          performedBy: "admin",
          adminUserId: req.user._id,
        });
      }
    }

    // Emit real-time socket update to the patient
    try {
      const { emitToPatient, EVENTS } = require("../utils/realtimeEvents");
      const payload = {
        reportCredits: patient.reportCredits,
        prescriptionCredits: patient.prescriptionCredits,
      };
      const payloadType = action === "add" ? "increase" : (action === "deduct" || action === "reset" ? "decrease" : null);
      if (payloadType) {
        payload.creditUpdated = {
          type: payloadType,
          amount: finalAmount,
          creditType: creditType,
          reason: reason.trim(),
        };
      }
      console.log('[Socket Debug] bulkAdjustPatientCredits emitting profile:updated for patient:', patient._id, 'payload:', JSON.stringify(payload));
      emitToPatient(patient._id, EVENTS.PROFILE_UPDATED, payload);
    } catch (socketErr) {
      console.error("Failed to emit profile:updated socket event in bulk adjust:", socketErr);
    }
  });

  await Promise.all(updatePromises);

  // Record audit activity
  await recordActivity({
    action: "PATIENT_CREDITS_BULK_ADJUSTED",
    entity: "PatientUser",
    user: req.user,
    description: `Bulk adjusted ${creditType} credits (${action} amount: ${amount || 'N/A'}) for ${updatedCount} patients. Reason: ${reason}`,
    ip: req.ip,
  });

  res.status(200).json({
    success: true,
    message: `Successfully adjusted credits for ${updatedCount} patients.`,
    updatedCount
  });
});

exports.getWelcomeBonus = catchAsync(async (req, res, next) => {
  const SystemSettings = require("../models/SystemSettings");
  let settings = await SystemSettings.findOne({ key: "welcome_bonus" });
  if (!settings) {
    settings = {
      value: {
        reportCredits: 10,
        prescriptionCredits: 15
      }
    };
  }
  res.status(200).json({
    success: true,
    data: settings.value
  });
});

exports.updateWelcomeBonus = catchAsync(async (req, res, next) => {
  const { reportCredits, prescriptionCredits } = req.body;
  if (typeof reportCredits !== "number" || reportCredits < 0) {
    return next(new AppError("Report credits must be a non-negative number.", 400));
  }
  if (typeof prescriptionCredits !== "number" || prescriptionCredits < 0) {
    return next(new AppError("Prescription credits must be a non-negative number.", 400));
  }

  const SystemSettings = require("../models/SystemSettings");

  const settings = await SystemSettings.findOneAndUpdate(
    { key: "welcome_bonus" },
    { value: { reportCredits, prescriptionCredits } },
    { upsert: true, new: true }
  );

  // Record audit activity
  await recordActivity({
    action: "SYSTEM_WELCOME_BONUS_UPDATED",
    entity: "SystemSettings",
    user: req.user,
    description: `Updated welcome bonus credits. Report: ${reportCredits}, Prescription: ${prescriptionCredits}`,
    ip: req.ip,
  });

  res.status(200).json({
    success: true,
    message: "Welcome bonus credits updated successfully.",
    data: settings.value
  });
});
