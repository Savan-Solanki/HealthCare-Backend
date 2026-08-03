const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const Log = require("../models/Log");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const recordActivity = require("../utils/recordActivity");
const sendEmail = require("../utils/sendEmail");
const { buildAuthEmailTemplate } = require("../utils/emailTemplates");
const { assertHospitalPortalAccess } = require("../utils/hospitalAccess");
const verifyTurnstile = require("../utils/verifyTurnstile");

const OTP_EXPIRY_MS = 2 * 60 * 1000;

const createTokenPayload = (user) => ({
  id: user._id.toString(),
  role: user.role,
});

const signAccessToken = (user) =>
  jwt.sign(createTokenPayload(user), process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "15m",
  });

const signRefreshToken = (user) =>
  jwt.sign(createTokenPayload(user), process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
  });

const getCookieOptions = (req) => {
  const isProd =
    process.env.NODE_ENV === "production" ||
    (req && req.headers && req.headers.origin && req.headers.origin.includes("medikwikhealthbuddy.in"));
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    domain: isProd ? ".medikwikhealthbuddy.in" : undefined,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
};

const setRefreshTokenCookie = (req, res, token, role) => {
  // Use role-specific cookie names so each portal has its own isolated session.
  const cookieName =
    role === "Receptionist"
      ? "re_refreshToken"
      : role === "Hospital Admin"
        ? "ha_refreshToken"
        : role === "Doctor"
          ? "dr_refreshToken"
          : "sa_refreshToken";
  res.cookie(cookieName, token, getCookieOptions(req));
};

const LOGIN_PORTALS = new Set(["super-admin", "hospital-admin", "receptionist", "doctor"]);

const assertLoginPortal = (user, portal) => {
  if (!portal || !LOGIN_PORTALS.has(portal)) return;

  const portalRoleMap = {
    "super-admin": ["Super Admin"],
    "hospital-admin": ["Hospital Admin"],
    receptionist: ["Receptionist"],
    doctor: ["Doctor"],
  };

  const allowedRoles = portalRoleMap[portal];
  if (!allowedRoles.includes(user.role)) {
    if (user.role === "Receptionist" && portal === "hospital-admin") {
      throw new AppError(
        "This is a receptionist account. Please sign in at the receptionist portal.",
        403
      );
    }
    if (user.role === "Hospital Admin" && portal === "receptionist") {
      throw new AppError(
        "This is a hospital admin account. Please sign in at the hospital admin portal.",
        403
      );
    }
    throw new AppError("This account cannot sign in from the selected portal.", 403);
  }
};


const normalizeHospitalName = (value) => value?.trim().toLowerCase();

const validateHospitalContext = (user, hospitalName) => {
  if (!["Hospital Admin", "Doctor", "Receptionist"].includes(user.role)) return;

  if (!hospitalName) {
    throw new AppError("Please provide hospital name.", 400);
  }

  const assignedHospitalName =
    typeof user.hospitalId === "object" && user.hospitalId
      ? user.hospitalId.name?.trim().toLowerCase()
      : null;

  if (!assignedHospitalName) {
    throw new AppError(`${user.role} account is not assigned to a hospital.`, 403);
  }

  if (assignedHospitalName !== hospitalName) {
    throw new AppError("Hospital name does not match this account.", 401);
  }
};

const sendOtpForPurpose = async ({ user, purpose }) => {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const otpHash = await bcrypt.hash(otp, 12);

  user.otpHash = otpHash;
  user.otpExpires = Date.now() + OTP_EXPIRY_MS;
  user.otpPurpose = purpose;
  await user.save({ validateBeforeSave: false });

  const emailTemplate = buildAuthEmailTemplate({
    userName: user.name,
    userRole: user.role,
    hospitalName:
      typeof user.hospitalId === "object" && user.hospitalId
        ? user.hospitalId.name || null
        : null,
    otp,
    purpose,
  });

  await sendEmail({
    email: user.email,
    subject: emailTemplate.subject,
    message: emailTemplate.message,
    html: emailTemplate.html,
  });
};

exports.register = catchAsync(async (req, res, next) => {
  return next(
    new AppError(
      "Admin portal registration is disabled. Ask the Super Admin to create the account.",
      403
    )
  );
});

exports.login = catchAsync(async (req, res, next) => {
  const password = req.body.password;
  const email = req.body.email?.trim().toLowerCase();
  const hospitalName = normalizeHospitalName(req.body.hospitalName);
  const turnstileToken = req.body.turnstileToken;

  if (!email || !password) {
    return next(new AppError("Please provide email and password.", 400));
  }

  const user = await User.findOne({ email })
    .select("+password +refreshToken")
    .populate("hospitalId", "name status accessType demoExpiresAt");

  if (!user || !(await user.comparePassword(password))) {
    return next(new AppError("Incorrect email or password.", 401));
  }

  assertLoginPortal(user, req.body.portal);
  validateHospitalContext(user, hospitalName);

  if (user.status === "Inactive" || user.status === "Suspended") {
    return next(new AppError("Account is deactivated. Contact administrator.", 403));
  }

  await assertHospitalPortalAccess(user, { populateHospital: true });

  await verifyTurnstile({ token: turnstileToken, ip: req.ip });

  try {
    await sendOtpForPurpose({ user, purpose: "login" });

    res.status(200).json({
      success: true,
      message: "OTP sent to email.",
      requiresOtp: true,
      otpExpiresIn: OTP_EXPIRY_MS / 1000,
    });
  } catch (err) {
    user.otpHash = undefined;
    user.otpExpires = undefined;
    user.otpPurpose = undefined;
    await user.save({ validateBeforeSave: false });
    return next(
      err instanceof AppError
        ? err
        : new AppError("There was an error sending the OTP email. Please try again.", 500)
    );
  }
});

exports.verifyOtp = catchAsync(async (req, res, next) => {
  const otp = req.body.otp;
  const email = req.body.email?.trim().toLowerCase();

  if (!email || !otp) {
    return next(new AppError("Please provide email and OTP.", 400));
  }

  const user = await User.findOne({ email })
    .select("+otpHash +otpExpires +otpPurpose +refreshToken")
    .populate("hospitalId", "name city hospitalCode status accessType demoExpiresAt");
  if (!user) {
    return next(new AppError("User not found.", 404));
  }

  assertLoginPortal(user, req.body.portal);

  if (!user.otpHash || !user.otpExpires || user.otpExpires < Date.now() || user.otpPurpose !== "login") {
    return next(new AppError("OTP is invalid or has expired.", 400));
  }

  const isOtpValid = await bcrypt.compare(otp, user.otpHash);
  if (!isOtpValid) {
    return next(new AppError("OTP is incorrect.", 401));
  }

  await assertHospitalPortalAccess(user, { populateHospital: true });

  user.otpHash = undefined;
  user.otpExpires = undefined;
  user.otpPurpose = undefined;
  user.lastLogin = new Date();
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  user.refreshToken = refreshToken;

  await user.save({ validateBeforeSave: false });
  await user.populate("hospitalId", "name city hospitalCode");

  setRefreshTokenCookie(req, res, refreshToken, user.role);

  await recordActivity({
    action: "USER_LOGIN",
    entity: "Auth",
    entityId: user._id,
    user,
    description: `User logged in via OTP: ${user.email}`,
    ip: req.ip,
  });

  res.status(200).json({
    success: true,
    message: "Login successful.",
    accessToken,
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      lastLogin: user.lastLogin,
      hospitalId: user.hospitalId,
    },
  });
});

exports.resendOtp = catchAsync(async (req, res, next) => {
  const email = req.body.email?.trim().toLowerCase();
  const hospitalName = normalizeHospitalName(req.body.hospitalName);
  const purpose = req.body.purpose === "password-reset" ? "password-reset" : "login";

  if (!email) {
    return next(new AppError("Please provide email.", 400));
  }

  const user = await User.findOne({ email })
    .select("+otpHash +otpExpires +otpPurpose")
    .populate("hospitalId", "name");

  if (!user) {
    return next(new AppError("User not found.", 404));
  }

  if (purpose === "login") {
    assertLoginPortal(user, req.body.portal);
  }
  validateHospitalContext(user, hospitalName);

  if (user.status === "Inactive" || user.status === "Suspended") {
    return next(new AppError("Account is deactivated. Contact administrator.", 403));
  }

  if (user.otpExpires && new Date(user.otpExpires).getTime() > Date.now()) {
    return next(new AppError("You can resend OTP only after 2 minutes.", 429));
  }

  try {
    await sendOtpForPurpose({ user, purpose });
    res.status(200).json({
      success: true,
      message: purpose === "password-reset" ? "Password reset OTP resent successfully." : "OTP resent successfully.",
      otpExpiresIn: OTP_EXPIRY_MS / 1000,
    });
  } catch {
    return next(new AppError("There was an error sending the OTP email. Please try again.", 500));
  }
});

exports.forgotPassword = catchAsync(async (req, res, next) => {
  const email = req.body.email?.trim().toLowerCase();
  const hospitalName = normalizeHospitalName(req.body.hospitalName);

  if (!email) {
    return next(new AppError("Please provide email.", 400));
  }

  const user = await User.findOne({ email })
    .select("+otpHash +otpExpires +otpPurpose")
    .populate("hospitalId", "name");

  if (!user) {
    return next(new AppError("User not found.", 404));
  }

  assertLoginPortal(user, req.body.portal);
  validateHospitalContext(user, hospitalName);

  if (user.status === "Inactive" || user.status === "Suspended") {
    return next(new AppError("Account is deactivated. Contact administrator.", 403));
  }

  try {
    await sendOtpForPurpose({ user, purpose: "password-reset" });
    res.status(200).json({
      success: true,
      message: "Password reset OTP sent to email.",
      otpExpiresIn: OTP_EXPIRY_MS / 1000,
    });
  } catch {
    user.otpHash = undefined;
    user.otpExpires = undefined;
    user.otpPurpose = undefined;
    await user.save({ validateBeforeSave: false });
    return next(new AppError("There was an error sending the OTP email. Please try again.", 500));
  }
});

exports.resetPassword = catchAsync(async (req, res, next) => {
  const email = req.body.email?.trim().toLowerCase();
  const hospitalName = normalizeHospitalName(req.body.hospitalName);
  const otp = req.body.otp;
  const newPassword = req.body.newPassword;

  if (!email || !otp || !newPassword) {
    return next(new AppError("Email, OTP, and new password are required.", 400));
  }

  const user = await User.findOne({ email })
    .select("+otpHash +otpExpires +otpPurpose +refreshToken")
    .populate("hospitalId", "name");

  if (!user) {
    return next(new AppError("User not found.", 404));
  }

  assertLoginPortal(user, req.body.portal);
  validateHospitalContext(user, hospitalName);

  if (!user.otpHash || !user.otpExpires || user.otpExpires < Date.now() || user.otpPurpose !== "password-reset") {
    return next(new AppError("OTP is invalid or has expired.", 400));
  }

  const isOtpValid = await bcrypt.compare(otp, user.otpHash);
  if (!isOtpValid) {
    return next(new AppError("OTP is incorrect.", 401));
  }

  user.password = newPassword;
  user.passwordChangedAt = new Date();
  user.refreshToken = undefined;
  user.otpHash = undefined;
  user.otpExpires = undefined;
  user.otpPurpose = undefined;
  await user.save();

  await recordActivity({
    action: "PASSWORD_RESET",
    entity: "Auth",
    entityId: user._id,
    user,
    description: `Password reset completed for ${user.email}`,
    ip: req.ip,
    meta: { role: user.role },
  });

  if (user.role === "Hospital Admin") {
    await Log.create({
      level: "info",
      message: `Hospital Admin password changed: ${user.email}`,
      source: "auth-password-reset",
      userId: user._id,
      ip: req.ip,
      method: req.method,
      path: req.originalUrl,
      meta: {
        role: user.role,
        hospitalName:
          typeof user.hospitalId === "object" && user.hospitalId
            ? user.hospitalId.name
            : null,
      },
    });
  }

  res.status(200).json({
    success: true,
    message: "Password reset successful. Please log in with your new password.",
  });
});

const pickRefreshToken = (req) => {
  const portal = req.body?.portal || req.headers["x-auth-portal"];
  const tokensByPortal = {
    "super-admin": req.cookies?.sa_refreshToken,
    "hospital-admin": req.cookies?.ha_refreshToken,
    receptionist: req.cookies?.re_refreshToken,
    doctor: req.cookies?.dr_refreshToken,
  };

  if (portal && tokensByPortal[portal]) {
    return tokensByPortal[portal];
  }

  return (
    req.cookies?.sa_refreshToken ||
    req.cookies?.ha_refreshToken ||
    req.cookies?.re_refreshToken ||
    req.cookies?.dr_refreshToken
  );
};

exports.refresh = catchAsync(async (req, res, next) => {
  const token = pickRefreshToken(req);

  if (!token) {
    return next(
      new AppError(
        "No refresh token cookie found. Log in first, then call POST /api/v1/auth/refresh with credentials: include.",
        401
      )
    );
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
  } catch {
    return next(new AppError("Invalid or expired refresh token.", 401));
  }

  const user = await User.findById(decoded.id)
    .select("+refreshToken")
    .populate("hospitalId", "name city hospitalCode");
  if (!user || user.refreshToken !== token) {
    return next(new AppError("Refresh token mismatch. Please log in again.", 401));
  }

  const newAccessToken = signAccessToken(user);
  const newRefreshToken = signRefreshToken(user);

  user.refreshToken = newRefreshToken;
  await user.save({ validateBeforeSave: false });

  setRefreshTokenCookie(req, res, newRefreshToken, user.role);

  res.status(200).json({
    success: true,
    accessToken: newAccessToken,
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      lastLogin: user.lastLogin,
      hospitalId: user.hospitalId,
    },
  });
});

exports.logout = catchAsync(async (req, res, next) => {
  // Check both role-specific refresh token cookies
  const token =
    req.cookies?.sa_refreshToken ||
    req.cookies?.ha_refreshToken ||
    req.cookies?.re_refreshToken ||
    req.cookies?.dr_refreshToken;

  if (token) {
    const decoded = jwt.decode(token);
    if (decoded?.id) {
      await User.findByIdAndUpdate(decoded.id, { refreshToken: null });
    }
  }

  const clearOpts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  };

  res.clearCookie("sa_refreshToken", clearOpts);
  res.clearCookie("ha_refreshToken", clearOpts);
  res.clearCookie("re_refreshToken", clearOpts);
  res.clearCookie("dr_refreshToken", clearOpts);
  // Also clear the old shared cookie name for clean migration
  res.clearCookie("refreshToken", clearOpts);

  res.status(200).json({ success: true, message: "Logged out successfully." });
});

exports.getMe = catchAsync(async (req, res, next) => {
  const user = await User.findById(req.user._id).populate("hospitalId", "name city");
  res.status(200).json({
    success: true,
    user,
  });
});
