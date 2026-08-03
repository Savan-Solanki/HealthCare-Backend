const jwt = require("jsonwebtoken");
const User = require("../models/User");
const PatientUser = require("../models/PatientUser");
const PatientSession = require("../models/PatientSession");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { assertHospitalPortalAccess } = require("../utils/hospitalAccess");
const Log = require("../models/Log");

// ─── Protect: verify JWT access token ─────────────────────────────────────────
const protect = catchAsync(async (req, res, next) => {
  let token;

  // 1) Get token from Authorization header
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (!token) {
    return next(new AppError("You are not logged in. Please log in to get access.", 401));
  }

  // 2) Verify token
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return next(new AppError("Your session has expired. Please log in again.", 401));
    }
    return next(new AppError("Invalid token. Please log in again.", 401));
  }

  // 3) Check if user still exists
  const currentUser = await User.findById(decoded.id).populate(
    "hospitalId",
    "name city hospitalCode status accessType demoExpiresAt"
  );
  if (!currentUser) {
    return next(new AppError("The user belonging to this token no longer exists.", 401));
  }

  // 4) Check if user changed password after token was issued
  if (currentUser.changedPasswordAfter(decoded.iat)) {
    return next(new AppError("User recently changed password. Please log in again.", 401));
  }

  // 5) Check if user is active
  if (currentUser.status === "Inactive" || currentUser.status === "Suspended") {
    return next(new AppError("Your account has been deactivated. Contact your administrator.", 403));
  }

  await assertHospitalPortalAccess(currentUser, { populateHospital: true });

  // Grant access
  req.user = currentUser;
  next();
});

// ─── Restrict to specific roles ────────────────────────────────────────────────
const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(
        new AppError("You do not have permission to perform this action.", 403)
      );
    }
    next();
  };
};

// ─── Protect Patient: verify JWT access token for Patients ────────────────────
const protectPatient = catchAsync(async (req, res, next) => {
  let token;

  // 1) Get token from Authorization header
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (!token) {
    return next(new AppError("You are not logged in. Please log in to get access.", 401));
  }

  // 2) Verify token
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return next(new AppError("Your session has expired. Please log in again.", 401));
    }
    return next(new AppError("Invalid token. Please log in again.", 401));
  }

  // 3) Validate sessionToken in database (Requirement 2 & 5)
  if (!decoded.sessionToken) {
    return next(new AppError("Your session has expired. Please log in again.", 401));
  }

  const session = await PatientSession.findOne({ sessionToken: decoded.sessionToken });
  if (!session) {
    return next(new AppError("Your session has been terminated. Please log in again.", 401));
  }

  if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
    await PatientSession.deleteOne({ _id: session._id });
    return next(new AppError("Your session has expired. Please log in again.", 401));
  }

  // 4) Check if patient still exists
  const currentPatient = await PatientUser.findById(decoded.id);
  if (!currentPatient) {
    return next(new AppError("The patient user belonging to this token no longer exists.", 401));
  }

  // ── Update lastActiveAt (fire-and-forget) ──
  PatientUser.updateOne(
    { _id: currentPatient._id },
    { $set: { lastActiveAt: new Date() } }
  ).exec().catch(() => {});

  PatientSession.updateOne(
    { _id: session._id },
    { $set: { lastActive: new Date() } }
  ).exec().catch(() => {});

  // Grant access
  req.user = currentPatient;
  req.sessionToken = decoded.sessionToken;
  next();
});

// ─── Protect Any: verify JWT token for either Patient or Staff User ───────────
const protectAny = catchAsync(async (req, res, next) => {
  let token;

  // Get token from Authorization header or Query param fallback
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
  } else if (req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return next(new AppError("You are not logged in. Please log in to get access.", 401));
  }

  // Verify token
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return next(new AppError("Your session has expired. Please log in again.", 401));
    }
    return next(new AppError("Invalid token. Please log in again.", 401));
  }

  // Check if it's a Patient session
  if (decoded.sessionToken) {
    const session = await PatientSession.findOne({ sessionToken: decoded.sessionToken });
    if (session) {
      if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
        await PatientSession.deleteOne({ _id: session._id });
        return next(new AppError("Your session has expired. Please log in again.", 401));
      }

      const currentPatient = await PatientUser.findById(decoded.id);
      if (currentPatient) {
        // Update lastActiveAt (fire-and-forget)
        PatientUser.updateOne(
          { _id: currentPatient._id },
          { $set: { lastActiveAt: new Date() } }
        ).exec().catch(() => {});

        PatientSession.updateOne(
          { _id: session._id },
          { $set: { lastActive: new Date() } }
        ).exec().catch(() => {});

        req.user = currentPatient;
        req.userType = "patient";
        req.sessionToken = decoded.sessionToken;
        return next();
      }
    }
  }

  // Check if it's a Staff User
  const currentUser = await User.findById(decoded.id).populate(
    "hospitalId",
    "name city hospitalCode status accessType demoExpiresAt"
  );
  if (currentUser) {
    if (currentUser.changedPasswordAfter(decoded.iat)) {
      return next(new AppError("User recently changed password. Please log in again.", 401));
    }

    if (currentUser.status === "Inactive" || currentUser.status === "Suspended") {
      return next(new AppError("Your account has been deactivated. Contact your administrator.", 403));
    }

    await assertHospitalPortalAccess(currentUser, { populateHospital: true });

    req.user = currentUser;
    req.userType = "staff";
    return next();
  }

  return next(new AppError("The user belonging to this token no longer exists.", 401));
});

module.exports = { protect, restrictTo, protectPatient, protectAny };
