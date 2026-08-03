const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const PatientUser = require("../models/PatientUser");
const PatientSession = require("../models/PatientSession");
const CreditTransaction = require("../models/CreditTransaction");
const SystemSettings = require("../models/SystemSettings");
const crypto = require("crypto");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { resolveMediaUrl } = require("../utils/mediaStorage");
const recordActivity = require("../utils/recordActivity");
const sendEmail = require("../utils/sendEmail");
const { buildAuthEmailTemplate } = require("../utils/emailTemplates");
const verifyTurnstile = require("../utils/verifyTurnstile");

const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || "").trim();
const OTP_EXPIRY_MS = 2 * 60 * 1000;
const RESET_REQUEST_LIMIT = 5;
const RESET_REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;
const RESET_BLOCK_DURATION_MS = 24 * 60 * 60 * 1000;
const PASSWORD_REGEX = /\d/;

const createTokenPayload = (patient, sessionToken) => ({
  id: patient._id.toString(),
  role: "Patient",
  sessionToken,
});

const signAccessToken = (patient, sessionToken) =>
  jwt.sign(createTokenPayload(patient, sessionToken), process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "15m",
  });

const signRefreshToken = (patient, sessionToken) =>
  jwt.sign(createTokenPayload(patient, sessionToken), process.env.JWT_REFRESH_SECRET, {
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

// clearCookie must NOT include maxAge (deprecated in Express v5)
const getClearCookieOptions = (req) => {
  const isProd =
    process.env.NODE_ENV === "production" ||
    (req && req.headers && req.headers.origin && req.headers.origin.includes("medikwikhealthbuddy.in"));
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    domain: isProd ? ".medikwikhealthbuddy.in" : undefined,
  };
};

const setRefreshTokenCookie = (req, res, token) => {
  res.cookie("pt_refreshToken", token, getCookieOptions(req));
};

const isStrongPassword = (value) =>
  typeof value === "string" && value.length >= 8 && PASSWORD_REGEX.test(value);

const buildPatientPayload = (patient) => ({
  id: patient._id,
  name: patient.name,
  email: patient.email,
  phone: patient.phone,
  avatar: patient.avatar,
  prescriptionCredits: patient.prescriptionCredits || 0,
  reportCredits: patient.reportCredits || 0,
});

const clearOtpState = (patient) => {
  patient.otpHash = undefined;
  patient.otpExpires = undefined;
  patient.otpPurpose = undefined;
};

const resetPasswordResetGuards = (patient, { clearRequestWindow = false } = {}) => {
  patient.resetOtpFailedAttempts = 0;
  patient.resetOtpBlockedUntil = null;
  if (clearRequestWindow) {
    patient.resetOtpRequestCount = 0;
    patient.resetOtpRequestWindowStart = null;
  }
};

const ensurePasswordResetNotBlocked = (patient) => {
  if (patient.resetOtpBlockedUntil && new Date(patient.resetOtpBlockedUntil).getTime() > Date.now()) {
    throw new AppError(
      "Password reset is temporarily blocked for 24 hours because of too many incorrect OTP attempts.",
      429
    );
  }

  if (patient.resetOtpBlockedUntil) {
    resetPasswordResetGuards(patient);
  }
};

const registerPasswordResetRequest = (patient, req = null) => {
  const now = Date.now();
  const windowStart = patient.resetOtpRequestWindowStart
    ? new Date(patient.resetOtpRequestWindowStart).getTime()
    : null;

  if (!windowStart || now - windowStart >= RESET_REQUEST_WINDOW_MS) {
    patient.resetOtpRequestWindowStart = new Date(now);
    patient.resetOtpRequestCount = 0;
  }

  if ((patient.resetOtpRequestCount || 0) >= RESET_REQUEST_LIMIT) {
    const blockedUntil = new Date(now + RESET_BLOCK_DURATION_MS);
    patient.resetOtpBlockedUntil = blockedUntil;
    clearOtpState(patient);

    // Log rate limit violation to DB
    const RateLimitViolation = require("../models/RateLimitViolation");
    try {
      RateLimitViolation.create({
        identifier: patient.email,
        identifierType: "userId",
        endpoint: req ? (req.originalUrl || req.url) : "/api/v1/patient/auth/forgot-password",
        method: req ? req.method : "POST",
        requestCount: patient.resetOtpRequestCount + 1,
        windowMs: RESET_BLOCK_DURATION_MS,
        blockedUntil,
        userAgent: req ? (req.headers["user-agent"] || null) : null,
        ip: req ? (req.ip || null) : null,
        patientUserId: patient._id,
      });
    } catch (dbErr) {
      console.error("Failed to log rate limit violation to DB:", dbErr);
    }

    throw new AppError(
      "You have requested OTP 5 times. Password reset is blocked for 24 hours.",
      429
    );
  }

  patient.resetOtpRequestCount = (patient.resetOtpRequestCount || 0) + 1;
};

const sendPatientOtpForPurpose = async ({ patient, purpose }) => {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const otpHash = await bcrypt.hash(otp, 12);

  patient.otpHash = otpHash;
  patient.otpExpires = new Date(Date.now() + OTP_EXPIRY_MS);
  patient.otpPurpose = purpose;
  await patient.save({ validateBeforeSave: false });

  const emailTemplate = buildAuthEmailTemplate({
    userName: patient.name || "Patient",
    userRole: "Patient",
    otp,
    purpose,
  });

  await sendEmail({
    email: patient.email,
    subject: emailTemplate.subject,
    message: emailTemplate.message,
    html: emailTemplate.html,
  });
};

const grantWelcomeCredits = async (patient) => {
  if (patient.welcomeCreditsGranted) return;

  let reportBonus = 10;
  let prescriptionBonus = 15;

  try {
    const settings = await SystemSettings.findOne({ key: "welcome_bonus" });
    if (settings && settings.value) {
      reportBonus = typeof settings.value.reportCredits === "number" ? settings.value.reportCredits : 10;
      prescriptionBonus = typeof settings.value.prescriptionCredits === "number" ? settings.value.prescriptionCredits : 15;
    }
  } catch (err) {
    console.error("Error reading welcome credits settings:", err);
  }

  patient.reportCredits = reportBonus;
  patient.prescriptionCredits = prescriptionBonus;
  patient.welcomeCreditsGranted = true;
  await patient.save({ validateBeforeSave: false });

  // Log transactions
  await CreditTransaction.create([
    {
      userId: patient._id,
      creditType: "report",
      type: "addition",
      amount: reportBonus,
      reason: "welcome_bonus",
      performedBy: "system",
    },
    {
      userId: patient._id,
      creditType: "prescription",
      type: "addition",
      amount: prescriptionBonus,
      reason: "welcome_bonus",
      performedBy: "system",
    },
  ]);
};

const checkDeviceSessionLimit = async ({ patientId, deviceId, forceLogoutDeviceId }) => {
  // Clear expired sessions first
  await PatientSession.deleteMany({ expiresAt: { $lt: new Date() } });

  // Get active sessions
  const activeSessions = await PatientSession.find({ userId: patientId }).sort({ lastActive: -1 });

  // If this device is already logged in, we update its session
  const existingSessionForDevice = activeSessions.find(s => s.deviceId === deviceId);
  if (existingSessionForDevice) {
    return { status: "allow_update", sessionToUpdate: existingSessionForDevice };
  }

  if (activeSessions.length >= 3) {
    if (forceLogoutDeviceId) {
      const sessionToRemove = activeSessions.find(s => s.deviceId === forceLogoutDeviceId);
      if (sessionToRemove) {
        await PatientSession.deleteOne({ _id: sessionToRemove._id });

        // Send system notification
        const NotificationLog = require("../models/NotificationLog");
        try {
          await NotificationLog.create({
            patientUserId: patientId,
            title: "Device Session Terminated",
            body: `Your session on device '${sessionToRemove.deviceName}' was removed because you logged in from another device.`,
            status: "sent",
            category: "system",
            actionUrl: "/dashboard",
          });
        } catch (err) {
          console.error("Failed to create termination notification:", err);
        }

        // Record audit activity
        await recordActivity({
          action: "PATIENT_SESSION_REMOVED",
          entity: "PatientUser",
          entityId: patientId,
          description: `Session on device '${sessionToRemove.deviceName}' (${sessionToRemove.deviceId}) was force removed due to limit.`,
        });

        return { status: "allow_create" };
      }
    }

    return {
      status: "limit_reached",
      sessions: activeSessions.map(s => ({
        deviceId: s.deviceId,
        deviceName: s.deviceName,
        deviceType: s.deviceType,
        browserVersion: s.browserVersion,
        loginTime: s.loginTime,
        lastActive: s.lastActive,
        isCurrentDevice: false,
      })),
    };
  }

  return { status: "allow_create" };
};

const createPatientSession = async ({ patient, req, res, action, description, ip }) => {
  // Extract device info
  const deviceId = req.body.deviceId || req.headers["x-device-id"] || "unknown_device_id";
  const deviceName = req.body.deviceName || req.headers["x-device-name"] || "Unknown Device";
  const deviceType = req.body.deviceType || req.headers["x-device-type"] || "Desktop";
  const browserVersion = req.body.browserVersion || req.headers["x-browser-version"] || "Unknown";
  const forceLogoutDeviceId = req.body.forceLogoutDeviceId;

  // Check device session limit
  const limitCheck = await checkDeviceSessionLimit({
    patientId: patient._id,
    deviceId,
    forceLogoutDeviceId,
  });

  if (limitCheck.status === "limit_reached") {
    return {
      limitReached: true,
      sessions: limitCheck.sessions,
    };
  }

  patient.lastLogin = new Date();
  patient.lastActiveAt = new Date();

  // Generate unique sessionToken
  const sessionToken = crypto.randomBytes(32).toString("hex");

  const accessToken = signAccessToken(patient, sessionToken);
  const refreshToken = signRefreshToken(patient, sessionToken);

  patient.refreshToken = refreshToken;
  await patient.save({ validateBeforeSave: false });

  // Expiration is 7 days from now (matching refresh token expiry)
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  // Register session in DB
  if (limitCheck.status === "allow_update" && limitCheck.sessionToUpdate) {
    const session = limitCheck.sessionToUpdate;
    session.sessionToken = sessionToken;
    session.deviceName = deviceName;
    session.deviceType = deviceType;
    session.browserVersion = browserVersion;
    session.loginTime = new Date();
    session.lastActive = new Date();
    session.ipAddress = ip || req.ip || "";
    session.expiresAt = expiresAt;
    await session.save();
  } else {
    await PatientSession.create({
      userId: patient._id,
      deviceId,
      deviceName,
      deviceType,
      browserVersion,
      sessionToken,
      loginTime: new Date(),
      lastActive: new Date(),
      ipAddress: ip || req.ip || "",
      expiresAt,
    });

    // Notify user of new device login
    const NotificationLog = require("../models/NotificationLog");
    try {
      await NotificationLog.create({
        patientUserId: patient._id,
        title: "New Device Login",
        body: `A new login session was started on device '${deviceName}'.`,
        status: "sent",
        category: "system",
        actionUrl: "/dashboard",
      });
    } catch (err) {
      console.error("Failed to create new login notification:", err);
    }
  }

  setRefreshTokenCookie(req, res, refreshToken);

  if (action && description) {
    await recordActivity({
      action,
      entity: "PatientUser",
      entityId: patient._id,
      description,
      ip,
    });
  }

  return {
    accessToken,
    user: buildPatientPayload(patient),
  };
};

// Verify Google ID Token
const verifyGoogleToken = async (idToken) => {
  if (!idToken) {
    throw new AppError("Google token is required.", 400);
  }
  if (!GOOGLE_CLIENT_ID) {
    throw new AppError("Google OAuth client ID is not configured.", 500);
  }
  try {
    const params = new URLSearchParams({ id_token: idToken });
    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?${params.toString()}`);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const message = payload.error_description === "Invalid Value"
        ? "Invalid Google credentials."
        : payload.error_description || payload.error || "Invalid Google credentials.";
      throw new AppError(message, 401);
    }
    const payload = await response.json();
    if (payload.aud !== GOOGLE_CLIENT_ID) {
      throw new AppError("Google client ID mismatch.", 401);
    }
    return payload;
  } catch (err) {
    if (err instanceof AppError) throw err;
    const code = err?.cause?.code || err?.code;
    const msg = code === "EACCES"
      ? "Backend cannot reach Google services. Please ensure the server has outbound internet access."
      : "Failed to verify Google token with Google services.";
    throw new AppError(msg, 502);
  }
};

// ─── REGISTER ─────────────────────────────────────────────────────────────────
exports.register = catchAsync(async (req, res, next) => {
  const { fullName, password, turnstileToken } = req.body;
  const email = req.body.email?.trim().toLowerCase();
  const mobile = req.body.mobile?.trim();

  if (!fullName || !email || !password || !mobile) {
    return next(new AppError("Please provide all required fields.", 400));
  }

  // Turnstile verification
  await verifyTurnstile({ token: turnstileToken, ip: req.ip });

  // Check email
  const existingEmail = await PatientUser.findOne({ email });
  if (existingEmail) {
    return next(new AppError("Email is already in use by another patient.", 409));
  }

  // Check mobile — allow up to 3 accounts per phone
  const phoneCount = await PatientUser.countDocuments({ phone: mobile });
  if (phoneCount >= 3) {
    return next(new AppError("Maximum account limit reached for this mobile number.", 409));
  }

  // Create PatientUser
  const patient = await PatientUser.create({
    name: fullName,
    email,
    password,
    phone: mobile,
    isMobileVerified: true,
    accountIndex: phoneCount,
    accountLabel: phoneCount === 0 ? "Self" : "",
    lastActiveAt: Date.now(),
  });

  // Grant welcome credits
  await grantWelcomeCredits(patient);

  const session = await createPatientSession({
    patient,
    req,
    res,
    action: "PATIENT_REGISTERED",
    description: `New patient registered: ${patient.email} with phone ${patient.phone}`,
    ip: req.ip,
  });

  if (session.limitReached) {
    return res.status(400).json({
      success: false,
      code: "MAX_DEVICES_REACHED",
      message: "Maximum device limit reached. Please logout from an existing device to continue.",
      sessions: session.sessions,
    });
  }

  res.status(201).json({
    success: true,
    message: "Registration successful.",
    accessToken: session.accessToken,
    user: session.user,
  });
});

// ─── LOGIN ────────────────────────────────────────────────────────────────────
exports.login = catchAsync(async (req, res, next) => {
  const { password, turnstileToken } = req.body;
  const email = req.body.email?.trim().toLowerCase();

  if (!email || !password) {
    return next(new AppError("Please provide email and password.", 400));
  }

  // Find user
  const patient = await PatientUser.findOne({ email }).select("+password +loginFailedAttempts +loginBlockedUntil");
  
  if (patient) {
    if (patient.loginBlockedUntil && new Date(patient.loginBlockedUntil).getTime() > Date.now()) {
      const remainingMinutes = Math.ceil((new Date(patient.loginBlockedUntil).getTime() - Date.now()) / (60 * 1000));
      return next(new AppError(`Too many login attempts. Your account is temporarily blocked. Please try again after ${remainingMinutes} minute(s).`, 429));
    }
    // If block expired, reset it
    if (patient.loginBlockedUntil) {
      patient.loginBlockedUntil = null;
      patient.loginFailedAttempts = 0;
      await patient.save({ validateBeforeSave: false });
    }
  }

  if (!patient || !(await patient.comparePassword(password))) {
    if (patient) {
      patient.loginFailedAttempts = (patient.loginFailedAttempts || 0) + 1;
      if (patient.loginFailedAttempts >= 3) {
        const blockDuration = 15 * 60 * 1000; // 15 mins block
        const blockedUntil = new Date(Date.now() + blockDuration);
        patient.loginBlockedUntil = blockedUntil;
        await patient.save({ validateBeforeSave: false });

        // Log rate limit violation to DB
        const RateLimitViolation = require("../models/RateLimitViolation");
        try {
          await RateLimitViolation.create({
            identifier: patient.email,
            identifierType: "userId",
            endpoint: req.originalUrl || req.url,
            method: req.method,
            requestCount: patient.loginFailedAttempts,
            windowMs: blockDuration,
            blockedUntil,
            userAgent: req.headers["user-agent"] || null,
            ip: req.ip || null,
            patientUserId: patient._id,
          });
        } catch (dbErr) {
          console.error("Failed to log rate limit violation to DB:", dbErr);
        }

        return next(new AppError("Too many login attempts. Your account is temporarily blocked. Please try again after 15 minutes.", 429));
      }
      await patient.save({ validateBeforeSave: false });
      const attemptsLeft = 3 - patient.loginFailedAttempts;
      return next(new AppError(`Incorrect email or password. ${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} remaining.`, 401));
    }
    return next(new AppError("Incorrect email or password.", 401));
  }

  // Turnstile verification (skip if retrying force logout as Turnstile token is one-time use)
  if (!req.body.forceLogoutDeviceId) {
    await verifyTurnstile({ token: turnstileToken, ip: req.ip });
  }

  // If they don't have a phone, return requiresMobile (though phone is required in schema, handle gracefully)
  if (!patient.phone) {
    return res.status(200).json({
      success: true,
      requiresMobile: true,
      email: patient.email,
    });
  }

  if (patient.isMobileVerified === false) {
    return next(new AppError("Complete your pending account verification first.", 403));
  }

  // Clear any failed login counters
  patient.loginFailedAttempts = 0;
  patient.loginBlockedUntil = null;

  // Update lastActiveAt on login
  patient.lastActiveAt = Date.now();

  const session = await createPatientSession({
    patient,
    req,
    res,
    action: "PATIENT_LOGIN",
    description: `Patient logged in: ${patient.email}`,
    ip: req.ip,
  });

  if (session.limitReached) {
    return res.status(400).json({
      success: false,
      code: "MAX_DEVICES_REACHED",
      message: "Maximum device limit reached. Please logout from an existing device to continue.",
      sessions: session.sessions,
    });
  }

  res.status(200).json({
    success: true,
    message: "Login successful.",
    accessToken: session.accessToken,
    user: session.user,
  });
});

// ─── GOOGLE LOGIN (DIRECT CHECK) ──────────────────────────────────────────────
exports.googleLogin = catchAsync(async (req, res, next) => {
  const { credential } = req.body;
  
  const payload = await verifyGoogleToken(credential);
  const googleEmail = payload.email.trim().toLowerCase();
  const googleId = payload.sub;

  // Search by Google ID or Email
  let patient = await PatientUser.findOne({ $or: [{ googleId }, { email: googleEmail }] }).select("+password");

  if (patient) {
    // If they exist and have a mobile number, log in directly
    if (patient.phone && patient.isMobileVerified !== false) {
      // Update googleId if not linked
      if (!patient.googleId) {
        patient.googleId = googleId;
      }
      if (payload.picture && !patient.avatar) {
        patient.avatar = payload.picture;
      }

      const session = await createPatientSession({
        patient,
        req,
        res,
        action: "PATIENT_GOOGLE_LOGIN",
        description: `Patient logged in via Google: ${patient.email}`,
        ip: req.ip,
      });

      if (session.limitReached) {
        return res.status(400).json({
          success: false,
          code: "MAX_DEVICES_REACHED",
          message: "Maximum device limit reached. Please logout from an existing device to continue.",
          sessions: session.sessions,
        });
      }

      return res.status(200).json({
        success: true,
        accessToken: session.accessToken,
        user: session.user,
      });
    } else {
      // Exist but no mobile number linked
      return res.status(200).json({
        success: true,
        requiresMobile: true,
        email: googleEmail,
        requiresPasswordSetup: !patient.password,
      });
    }
  }

  // Patient does not exist, requires mobile linking to create
  res.status(200).json({
    success: true,
    requiresMobile: true,
    email: googleEmail,
    requiresPasswordSetup: true,
  });
});

// ─── GOOGLE MOBILE (LINK & REGISTER) ──────────────────────────────────────────
exports.googleMobile = catchAsync(async (req, res, next) => {
  const { credential, password } = req.body;
  const mobile = req.body.mobile?.trim();

  if (!mobile) {
    return next(new AppError("Please provide a mobile number.", 400));
  }

  const payload = await verifyGoogleToken(credential);
  const googleEmail = payload.email.trim().toLowerCase();
  const googleId = payload.sub;
  const name = payload.name;
  const avatar = payload.picture || null;

  // Enforce max 3 accounts per phone
  const phoneCount = await PatientUser.countDocuments({ phone: mobile });
  const existingMobile = await PatientUser.findOne({ phone: mobile, email: googleEmail });
  if (!existingMobile && phoneCount >= 3) {
    return next(new AppError("Maximum account limit reached for this mobile number.", 409));
  }

  // Find or create account
  let patient = await PatientUser.findOne({ $or: [{ googleId }, { email: googleEmail }] })
    .select("+password +otpHash +otpExpires +otpPurpose");
  const needsPasswordSetup = !patient || !patient.password;

  if (needsPasswordSetup && !isStrongPassword(password)) {
    return next(new AppError("Password must be at least 8 characters and contain a number.", 400));
  }

  if (patient?.otpPurpose === "account-setup" && patient.otpExpires && new Date(patient.otpExpires).getTime() > Date.now()) {
    return next(new AppError("You can resend OTP only after 2 minutes.", 429));
  }

  if (patient) {
    patient.phone = mobile;
    if (!patient.googleId) patient.googleId = googleId;
    if (avatar && !patient.avatar) patient.avatar = avatar;
    if (!patient.password) patient.password = password;
    if (patient.accountIndex == null) patient.accountIndex = phoneCount;
  } else {
    const newIndex = await PatientUser.countDocuments({ phone: mobile });
    patient = new PatientUser({
      name,
      email: googleEmail,
      googleId,
      phone: mobile,
      avatar,
      password,
      isMobileVerified: false,
      accountIndex: newIndex,
      accountLabel: newIndex === 0 ? "Self" : "",
      lastActiveAt: Date.now(),
    });
  }

  patient.isMobileVerified = false;

  try {
    await sendPatientOtpForPurpose({ patient, purpose: "account-setup" });
    res.status(200).json({
      success: true,
      message: "Verification OTP sent to your email.",
      requiresOtp: true,
      otpExpiresIn: OTP_EXPIRY_MS / 1000,
      email: googleEmail,
    });
  } catch (err) {
    clearOtpState(patient);
    await patient.save({ validateBeforeSave: false });
    return next(
      err instanceof AppError
        ? err
        : new AppError("There was an error sending the OTP email. Please try again.", 500)
    );
  }
});

// ─── ADD MOBILE ───────────────────────────────────────────────────────────────
exports.addMobile = catchAsync(async (req, res, next) => {
  const { email, mobile } = req.body;

  if (!email || !mobile) {
    return next(new AppError("Email and mobile number are required.", 400));
  }

  // Check mobile — allow up to 3 accounts per phone
  const phoneCount = await PatientUser.countDocuments({ phone: mobile });
  const existingMobile = await PatientUser.findOne({ phone: mobile, email: email.trim().toLowerCase() });
  if (!existingMobile && phoneCount >= 3) {
    return next(new AppError("Maximum account limit reached for this mobile number.", 409));
  }

  const patient = await PatientUser.findOne({ email: email.trim().toLowerCase() });
  if (!patient) {
    return next(new AppError("Patient account not found.", 404));
  }

  patient.phone = mobile;
  patient.isMobileVerified = true;

  // Grant welcome credits if not already granted
  await grantWelcomeCredits(patient);

  const session = await createPatientSession({
    patient,
    req,
    res,
    action: "PATIENT_ADD_MOBILE",
    description: `Patient added mobile number: ${patient.email} (${patient.phone})`,
    ip: req.ip,
  });

  if (session.limitReached) {
    return res.status(400).json({
      success: false,
      code: "MAX_DEVICES_REACHED",
      message: "Maximum device limit reached. Please logout from an existing device to continue.",
      sessions: session.sessions,
    });
  }

  res.status(200).json({
    success: true,
    accessToken: session.accessToken,
    user: session.user,
  });
});

// ─── REFRESH TOKEN ────────────────────────────────────────────────────────────
exports.refresh = catchAsync(async (req, res, next) => {
  const token = req.cookies?.pt_refreshToken;
  if (!token) return next(new AppError("No refresh token provided.", 401));

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
  } catch {
    return next(new AppError("Invalid or expired refresh token.", 401));
  }

  const patient = await PatientUser.findById(decoded.id).select("+refreshToken");
  if (!patient || patient.refreshToken !== token) {
    return next(new AppError("Refresh token mismatch. Please log in again.", 401));
  }

  // Validate session
  if (!decoded.sessionToken) {
    res.clearCookie("pt_refreshToken", getClearCookieOptions(req));
    return next(new AppError("Invalid session token. Please log in again.", 401));
  }

  const session = await PatientSession.findOne({ sessionToken: decoded.sessionToken });
  if (!session) {
    res.clearCookie("pt_refreshToken", getClearCookieOptions(req));
    return next(new AppError("Your session has been terminated. Please log in again.", 401));
  }

  // Generate new session token (Requirement 5: prevent session token reuse)
  const newSessionToken = crypto.randomBytes(32).toString("hex");
  session.sessionToken = newSessionToken;
  session.lastActive = new Date();
  session.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await session.save();

  const newAccessToken = signAccessToken(patient, newSessionToken);
  const newRefreshToken = signRefreshToken(patient, newSessionToken);

  patient.refreshToken = newRefreshToken;
  patient.lastActiveAt = new Date();
  await patient.save({ validateBeforeSave: false });

  setRefreshTokenCookie(req, res, newRefreshToken);

  res.status(200).json({
    success: true,
    accessToken: newAccessToken,
    user: buildPatientPayload(patient),
  });
});

// ─── LOGOUT ───────────────────────────────────────────────────────────────────
exports.logout = catchAsync(async (req, res, next) => {
  const token = req.cookies?.pt_refreshToken;
  if (token) {
    const decoded = jwt.decode(token);
    if (decoded?.id) {
      await PatientUser.findByIdAndUpdate(decoded.id, { refreshToken: null });
      if (decoded.sessionToken) {
        await PatientSession.deleteOne({ sessionToken: decoded.sessionToken });
      }
    }
  }

  const clearOpts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  };

  res.clearCookie("pt_refreshToken", clearOpts);

  res.status(200).json({ success: true, message: "Logged out successfully." });
});

// ─── GET ME (CURRENT USER) ────────────────────────────────────────────────────
exports.getMe = catchAsync(async (req, res, next) => {
  const avatar = await resolveMediaUrl(req.user.avatar);

  res.status(200).json({
    success: true,
    user: {
      id: req.user._id,
      name: req.user.name,
      email: req.user.email,
      phone: req.user.phone,
      avatar,
      prescriptionCredits: req.user.prescriptionCredits || 0,
      reportCredits: req.user.reportCredits || 0,
      fcmToken: req.user.fcmToken,
      fcmTokens: req.user.fcmTokens || [],
    },
  });
});

// ─── MOCK OTP ENDPOINTS (Bypassed by returning direct auth token or mock success) ───
exports.verifyOtp = catchAsync(async (req, res, next) => {
  const { email, mobile } = req.body;
  const targetEmail = email?.trim().toLowerCase();
  
  const patient = await PatientUser.findOne({ $or: [{ email: targetEmail }, { phone: mobile }] });
  if (!patient) {
    return next(new AppError("Patient account not found.", 404));
  }

  // Grant welcome credits if not already granted
  await grantWelcomeCredits(patient);

  const session = await createPatientSession({
    patient,
    req,
    res,
    action: "PATIENT_VERIFY_OTP",
    description: `Patient verified OTP: ${patient.email}`,
    ip: req.ip,
  });

  if (session.limitReached) {
    return res.status(400).json({
      success: false,
      code: "MAX_DEVICES_REACHED",
      message: "Maximum device limit reached. Please logout from an existing device to continue.",
      sessions: session.sessions,
    });
  }

  res.status(200).json({
    success: true,
    message: "OTP verified successfully (bypassed).",
    accessToken: session.accessToken,
    user: session.user,
  });
});

exports.verifyGoogleOtp = catchAsync(async (req, res, next) => {
  const { credential, mobile, otp } = req.body;
  const payload = await verifyGoogleToken(credential);
  const googleEmail = payload.email.trim().toLowerCase();
  const googleId = payload.sub;

  const patient = await PatientUser.findOne({ $or: [{ googleId }, { email: googleEmail }] })
    .select("+otpHash +otpExpires +otpPurpose +refreshToken +resetOtpFailedAttempts +resetOtpBlockedUntil");
  if (!patient || patient.phone !== mobile) {
    return next(new AppError("Patient account not found.", 404));
  }

  if (patient.resetOtpBlockedUntil && new Date(patient.resetOtpBlockedUntil).getTime() > Date.now()) {
    return next(new AppError("Too many incorrect OTP attempts. Account verification is blocked for 24 hours.", 429));
  }

  if (!patient.otpHash || !patient.otpExpires || patient.otpExpires < Date.now() || patient.otpPurpose !== "account-setup") {
    return next(new AppError("OTP is invalid or has expired.", 400));
  }

  const isOtpValid = await bcrypt.compare(otp, patient.otpHash);
  if (!isOtpValid) {
    patient.resetOtpFailedAttempts = (patient.resetOtpFailedAttempts || 0) + 1;

    if (patient.resetOtpFailedAttempts >= 5) {
      const blockedUntil = new Date(Date.now() + RESET_BLOCK_DURATION_MS);
      patient.resetOtpBlockedUntil = blockedUntil;
      clearOtpState(patient);
      await patient.save({ validateBeforeSave: false });

      // Log rate limit violation to DB
      const RateLimitViolation = require("../models/RateLimitViolation");
      try {
        await RateLimitViolation.create({
          identifier: patient.email,
          identifierType: "userId",
          endpoint: req.originalUrl || req.url,
          method: req.method,
          requestCount: patient.resetOtpFailedAttempts,
          windowMs: RESET_BLOCK_DURATION_MS,
          blockedUntil,
          userAgent: req.headers["user-agent"] || null,
          ip: req.ip || null,
          patientUserId: patient._id,
        });
      } catch (dbErr) {
        console.error("Failed to log rate limit violation to DB:", dbErr);
      }

      return next(new AppError("Too many incorrect OTP attempts. Account verification is blocked for 24 hours.", 429));
    }

    await patient.save({ validateBeforeSave: false });
    const attemptsLeft = 5 - patient.resetOtpFailedAttempts;
    return next(new AppError(`OTP is incorrect. ${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} remaining.`, 401));
  }

  patient.isMobileVerified = true;
  patient.resetOtpFailedAttempts = 0;
  patient.resetOtpBlockedUntil = null;
  clearOtpState(patient);

  // Grant welcome credits if not already granted
  await grantWelcomeCredits(patient);

  const session = await createPatientSession({
    patient,
    req,
    res,
    action: "PATIENT_GOOGLE_REGISTER",
    description: `Patient registered/linked via Google & Mobile: ${patient.email} (${patient.phone})`,
    ip: req.ip,
  });

  if (session.limitReached) {
    return res.status(400).json({
      success: false,
      code: "MAX_DEVICES_REACHED",
      message: "Maximum device limit reached. Please logout from an existing device to continue.",
      sessions: session.sessions,
    });
  }

  res.status(200).json({
    success: true,
    message: "Google account setup verified successfully.",
    accessToken: session.accessToken,
    user: session.user,
  });
});

exports.resendGoogleOtp = catchAsync(async (req, res, next) => {
  const { credential } = req.body;
  const payload = await verifyGoogleToken(credential);
  const googleEmail = payload.email.trim().toLowerCase();
  const googleId = payload.sub;

  const patient = await PatientUser.findOne({ $or: [{ googleId }, { email: googleEmail }] })
    .select("+otpHash +otpExpires +otpPurpose");

  if (!patient || !patient.phone) {
    return next(new AppError("Patient account not found.", 404));
  }

  if (patient.isMobileVerified !== false) {
    return next(new AppError("This account is already verified.", 400));
  }

  if (patient.otpExpires && new Date(patient.otpExpires).getTime() > Date.now()) {
    return next(new AppError("You can resend OTP only after 2 minutes.", 429));
  }

  try {
    await sendPatientOtpForPurpose({ patient, purpose: "account-setup" });
    res.status(200).json({
      success: true,
      message: "Verification OTP resent to your email.",
      otpExpiresIn: OTP_EXPIRY_MS / 1000,
    });
  } catch {
    clearOtpState(patient);
    await patient.save({ validateBeforeSave: false });
    return next(new AppError("There was an error sending the OTP email. Please try again.", 500));
  }
});

exports.forgotPassword = catchAsync(async (req, res, next) => {
  const email = req.body.email?.trim().toLowerCase();

  if (!email) {
    return next(new AppError("Please provide email.", 400));
  }

  const patient = await PatientUser.findOne({ email })
    .select("+otpHash +otpExpires +otpPurpose +resetOtpRequestCount +resetOtpRequestWindowStart +resetOtpFailedAttempts +resetOtpBlockedUntil");

  if (!patient) {
    return next(new AppError("Patient account not found.", 404));
  }

  ensurePasswordResetNotBlocked(patient);

  if (patient.otpPurpose === "password-reset" && patient.otpExpires && new Date(patient.otpExpires).getTime() > Date.now()) {
    return next(new AppError("You can request a new OTP only after 2 minutes.", 429));
  }

  const previousCount = patient.resetOtpRequestCount;
  const previousWindowStart = patient.resetOtpRequestWindowStart;
  registerPasswordResetRequest(patient, req);

  try {
    await sendPatientOtpForPurpose({ patient, purpose: "password-reset" });
    res.status(200).json({
      success: true,
      message: "Password reset OTP sent to email.",
      otpExpiresIn: OTP_EXPIRY_MS / 1000,
    });
  } catch {
    clearOtpState(patient);
    patient.resetOtpRequestCount = previousCount;
    patient.resetOtpRequestWindowStart = previousWindowStart;
    await patient.save({ validateBeforeSave: false });
    return next(new AppError("There was an error sending the OTP email. Please try again.", 500));
  }
});

exports.resendPasswordResetOtp = catchAsync(async (req, res, next) => {
  const email = req.body.email?.trim().toLowerCase();

  if (!email) {
    return next(new AppError("Please provide email.", 400));
  }

  const patient = await PatientUser.findOne({ email })
    .select("+otpHash +otpExpires +otpPurpose +resetOtpRequestCount +resetOtpRequestWindowStart +resetOtpFailedAttempts +resetOtpBlockedUntil");

  if (!patient) {
    return next(new AppError("Patient account not found.", 404));
  }

  ensurePasswordResetNotBlocked(patient);

  if (patient.otpPurpose === "password-reset" && patient.otpExpires && new Date(patient.otpExpires).getTime() > Date.now()) {
    return next(new AppError("You can request a new OTP only after 2 minutes.", 429));
  }

  const previousCount = patient.resetOtpRequestCount;
  const previousWindowStart = patient.resetOtpRequestWindowStart;
  registerPasswordResetRequest(patient, req);

  try {
    await sendPatientOtpForPurpose({ patient, purpose: "password-reset" });
    res.status(200).json({
      success: true,
      message: "Password reset OTP resent successfully.",
      otpExpiresIn: OTP_EXPIRY_MS / 1000,
    });
  } catch {
    clearOtpState(patient);
    patient.resetOtpRequestCount = previousCount;
    patient.resetOtpRequestWindowStart = previousWindowStart;
    await patient.save({ validateBeforeSave: false });
    return next(new AppError("There was an error sending the OTP email. Please try again.", 500));
  }
});

exports.resetPassword = catchAsync(async (req, res, next) => {
  const email = req.body.email?.trim().toLowerCase();
  const otp = req.body.otp;
  const newPassword = req.body.newPassword;

  if (!email || !otp || !newPassword) {
    return next(new AppError("Email, OTP, and new password are required.", 400));
  }

  const patient = await PatientUser.findOne({ email })
    .select("+password +refreshToken +otpHash +otpExpires +otpPurpose +resetOtpRequestCount +resetOtpRequestWindowStart +resetOtpFailedAttempts +resetOtpBlockedUntil");

  if (!patient) {
    return next(new AppError("Patient account not found.", 404));
  }

  ensurePasswordResetNotBlocked(patient);

  if (!patient.otpHash || !patient.otpExpires || patient.otpExpires < Date.now() || patient.otpPurpose !== "password-reset") {
    return next(new AppError("OTP is invalid or has expired.", 400));
  }

  const isOtpValid = await bcrypt.compare(otp, patient.otpHash);
  if (!isOtpValid) {
    patient.resetOtpFailedAttempts = (patient.resetOtpFailedAttempts || 0) + 1;

    if (patient.resetOtpFailedAttempts >= 5) {
      const blockedUntil = new Date(Date.now() + RESET_BLOCK_DURATION_MS);
      patient.resetOtpBlockedUntil = blockedUntil;
      clearOtpState(patient);
      await patient.save({ validateBeforeSave: false });

      // Log rate limit violation to DB
      const RateLimitViolation = require("../models/RateLimitViolation");
      try {
        await RateLimitViolation.create({
          identifier: patient.email,
          identifierType: "userId",
          endpoint: req.originalUrl || req.url,
          method: req.method,
          requestCount: patient.resetOtpFailedAttempts,
          windowMs: RESET_BLOCK_DURATION_MS,
          blockedUntil,
          userAgent: req.headers["user-agent"] || null,
          ip: req.ip || null,
          patientUserId: patient._id,
        });
      } catch (dbErr) {
        console.error("Failed to log rate limit violation to DB:", dbErr);
      }

      return next(new AppError("Too many incorrect OTP attempts. Password reset is blocked for 24 hours.", 429));
    }

    await patient.save({ validateBeforeSave: false });
    const attemptsLeft = 5 - patient.resetOtpFailedAttempts;
    return next(new AppError(`OTP is incorrect. ${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} remaining.`, 401));
  }

  if (!isStrongPassword(newPassword)) {
    return next(new AppError("Password must be at least 8 characters and contain a number.", 400));
  }

  patient.password = newPassword;
  patient.passwordChangedAt = new Date();
  patient.refreshToken = undefined;
  clearOtpState(patient);
  resetPasswordResetGuards(patient, { clearRequestWindow: true });
  await patient.save();

  await recordActivity({
    action: "PATIENT_PASSWORD_RESET",
    entity: "PatientUser",
    entityId: patient._id,
    description: `Patient password reset completed for ${patient.email}`,
    ip: req.ip,
  });

  res.status(200).json({
    success: true,
    message: "Password reset successful. Please log in with your new password.",
  });
});

exports.resendOtp = catchAsync(async (req, res, next) => {
  res.status(200).json({
    success: true,
    message: "OTP resent successfully (mock).",
    otpExpiresIn: 120,
  });
});

// ─── GOOGLE ADD ACCOUNT ───────────────────────────────────────────────────────
exports.googleAddAccount = catchAsync(async (req, res, next) => {
  const currentUser = req.user;
  const { credential } = req.body;

  // Verify Google token
  const payload = await verifyGoogleToken(credential);
  const googleEmail = payload.email.trim().toLowerCase();
  const googleId = payload.sub;
  const googleName = payload.name;
  const googleAvatar = payload.picture || null;

  // Check max accounts per phone
  const phoneCount = await PatientUser.countDocuments({ phone: currentUser.phone });

  // Check if a PatientUser with this Google email/ID already exists
  let existingPatient = await PatientUser.findOne({ $or: [{ googleId }, { email: googleEmail }] });

  if (existingPatient) {
    // If the existing patient has the same phone — auto-switch to that account
    if (existingPatient.phone === currentUser.phone) {
      // If it's the same account as current, just return
      if (String(existingPatient._id) === String(currentUser._id)) {
        return res.status(200).json({
          success: true,
          alreadyActive: true,
          message: "This is already your active account.",
        });
      }

      // Switch to existing account
      const session = await createPatientSession({
        patient: existingPatient,
        req,
        res,
        action: "PATIENT_GOOGLE_ADD_SWITCH",
        description: `Switched to existing Google-linked account: ${existingPatient.email}`,
        ip: req.ip,
      });

      if (session.limitReached) {
        return res.status(400).json({
          success: false,
          code: "MAX_DEVICES_REACHED",
          message: "Maximum device limit reached.",
          sessions: session.sessions,
        });
      }

      // Clear old session
      currentUser.refreshToken = undefined;
      await PatientUser.updateOne({ _id: currentUser._id }, { $unset: { refreshToken: "" } });
      if (req.sessionToken) {
        await PatientSession.deleteOne({ sessionToken: req.sessionToken });
      }

      // Update googleId if not linked
      if (!existingPatient.googleId) {
        existingPatient.googleId = googleId;
        await existingPatient.save({ validateBeforeSave: false });
      }

      const accountsList = await PatientUser.find(
        { phone: existingPatient.phone },
        "name email avatar age gender accountIndex accountLabel createdAt"
      ).sort({ accountIndex: 1 }).lean();

      const mappedAccounts = accountsList.map((a) => ({
        id: String(a._id),
        name: a.name,
        email: a.email,
        avatar: a.avatar || null,
        age: a.age || null,
        gender: a.gender || null,
        accountIndex: a.accountIndex ?? 0,
        accountLabel: a.accountLabel || "",
        isActive: String(a._id) === String(existingPatient._id),
      }));

      const userPayload = {
        id: String(existingPatient._id),
        name: existingPatient.name,
        email: existingPatient.email,
        phone: existingPatient.phone,
        avatar: existingPatient.avatar || null,
        accountIndex: existingPatient.accountIndex ?? 0,
        accountLabel: existingPatient.accountLabel || "",
      };

      return res.status(200).json({
        success: true,
        existingAccount: true,
        accessToken: session.accessToken,
        user: userPayload,
        accounts: mappedAccounts,
      });
    } else {
      // Different phone number — block
      return res.status(409).json({
        success: false,
        message: "This Google account is already linked to a different phone number.",
      });
    }
  }

  // No existing patient — check if we can add more
  if (phoneCount >= 3) {
    return res.status(409).json({
      success: false,
      message: "Maximum account limit reached for this mobile number.",
    });
  }

  // Return setup required — frontend will show mobile + password form
  return res.status(200).json({
    success: true,
    requiresSetup: true,
    googleEmail,
    googleName,
    googleAvatar,
  });
});

// ─── GOOGLE COMPLETE ADD ACCOUNT ──────────────────────────────────────────────
exports.googleCompleteAddAccount = catchAsync(async (req, res, next) => {
  const currentUser = req.user;
  const { credential, password } = req.body;

  if (!credential) throw new AppError("Google credential is required.", 400);
  if (!isStrongPassword(password)) {
    throw new AppError("Password must be at least 8 characters and contain a number.", 400);
  }

  const payload = await verifyGoogleToken(credential);
  const googleEmail = payload.email.trim().toLowerCase();
  const googleId = payload.sub;
  const googleName = payload.name;
  const googleAvatar = payload.picture || null;

  // Double-check no one else registered with this email in the meantime
  const emailExists = await PatientUser.findOne({ email: googleEmail });
  if (emailExists) {
    throw new AppError("An account with this email already exists.", 409);
  }

  const phoneCount = await PatientUser.countDocuments({ phone: currentUser.phone });
  if (phoneCount >= 3) {
    throw new AppError("Maximum account limit reached for this mobile number.", 409);
  }

  const newAccount = await PatientUser.create({
    name: googleName || "Patient",
    email: googleEmail,
    googleId,
    password,
    phone: currentUser.phone,
    avatar: googleAvatar,
    isMobileVerified: true,
    accountIndex: phoneCount,
    accountLabel: "",
    lastActiveAt: Date.now(),
  });

  await grantWelcomeCredits(newAccount);

  const session = await createPatientSession({
    patient: newAccount,
    req,
    res,
    action: "PATIENT_GOOGLE_ADD_ACCOUNT",
    description: `Created new Google-linked account: ${newAccount.email}`,
    ip: req.ip,
  });

  if (session.limitReached) {
    await PatientUser.deleteOne({ _id: newAccount._id });
    return res.status(400).json({
      success: false,
      code: "MAX_DEVICES_REACHED",
      message: "Maximum device limit reached.",
      sessions: session.sessions,
    });
  }

  // Clear old session
  currentUser.refreshToken = undefined;
  await PatientUser.updateOne({ _id: currentUser._id }, { $unset: { refreshToken: "" } });
  if (req.sessionToken) {
    await PatientSession.deleteOne({ sessionToken: req.sessionToken });
  }

  const accountsList = await PatientUser.find(
    { phone: newAccount.phone },
    "name email avatar age gender accountIndex accountLabel createdAt"
  ).sort({ accountIndex: 1 }).lean();

  const mappedAccounts = accountsList.map((a) => ({
    id: String(a._id),
    name: a.name,
    email: a.email,
    avatar: a.avatar || null,
    age: a.age || null,
    gender: a.gender || null,
    accountIndex: a.accountIndex ?? 0,
    accountLabel: a.accountLabel || "",
    isActive: String(a._id) === String(newAccount._id),
  }));

  const userPayload = {
    id: String(newAccount._id),
    name: newAccount.name,
    email: newAccount.email,
    phone: newAccount.phone,
    avatar: newAccount.avatar || null,
    accountIndex: newAccount.accountIndex,
    accountLabel: newAccount.accountLabel,
  };

  res.status(201).json({
    success: true,
    accessToken: session.accessToken,
    user: userPayload,
    accounts: mappedAccounts,
    data: {
      accessToken: session.accessToken,
      user: userPayload,
      accounts: mappedAccounts,
    },
  });
});

// ─── GET LINKED ACCOUNTS ──────────────────────────────────────────────────────
exports.getLinkedAccounts = catchAsync(async (req, res) => {
  const currentUser = req.user;
  const accounts = await PatientUser.find(
    { phone: currentUser.phone },
    "name email avatar age gender accountIndex accountLabel createdAt"
  ).sort({ accountIndex: 1 }).lean();

  const mapped = accounts.map((a) => ({
    id: a._id,
    name: a.name,
    email: a.email,
    avatar: a.avatar || null,
    age: a.age || null,
    gender: a.gender || null,
    accountIndex: a.accountIndex ?? 0,
    accountLabel: a.accountLabel || "",
    isActive: String(a._id) === String(currentUser._id),
  }));

  res.status(200).json({ success: true, accounts: mapped, data: mapped });
});

// ─── SWITCH ACCOUNT ───────────────────────────────────────────────────────────
exports.switchAccount = catchAsync(async (req, res) => {
  const { targetAccountId } = req.body;
  if (!targetAccountId) throw new AppError("Target account ID is required.", 400);

  const currentUser = req.user;
  const targetUser = await PatientUser.findById(targetAccountId).select("+refreshToken");

  if (!targetUser) throw new AppError("Account not found.", 404);
  if (targetUser.phone !== currentUser.phone) {
    throw new AppError("You can only switch to accounts linked to the same mobile number.", 403);
  }

  const session = await createPatientSession({
    patient: targetUser,
    req,
    res,
    action: "PATIENT_SWITCH_ACCOUNT",
    description: `Switched account to: ${targetUser.email}`,
    ip: req.ip,
  });

  if (session.limitReached) {
    return res.status(400).json({
      success: false,
      code: "MAX_DEVICES_REACHED",
      message: "Maximum device limit reached. Please logout from an existing device to continue.",
      sessions: session.sessions,
    });
  }

  // Clear old account's refresh token
  currentUser.refreshToken = undefined;
  await PatientUser.updateOne({ _id: currentUser._id }, { $unset: { refreshToken: "" } });

  // Delete the old session from the DB as we are replacing it with targetUser's session
  if (req.sessionToken) {
    await PatientSession.deleteOne({ sessionToken: req.sessionToken });
  }

  const accountsList = await PatientUser.find(
    { phone: targetUser.phone },
    "name email avatar age gender accountIndex accountLabel createdAt"
  ).sort({ accountIndex: 1 }).lean();

  const mappedAccounts = accountsList.map((a) => ({
    id: String(a._id),
    name: a.name,
    email: a.email,
    avatar: a.avatar || null,
    age: a.age || null,
    gender: a.gender || null,
    accountIndex: a.accountIndex ?? 0,
    accountLabel: a.accountLabel || "",
    isActive: String(a._id) === String(targetUser._id),
  }));

  const userPayload = {
    id: String(targetUser._id),
    name: targetUser.name,
    email: targetUser.email,
    phone: targetUser.phone,
    avatar: targetUser.avatar || null,
    age: targetUser.age || null,
    gender: targetUser.gender || null,
    accountIndex: targetUser.accountIndex ?? 0,
    accountLabel: targetUser.accountLabel || "",
  };

  res.status(200).json({
    success: true,
    accessToken: session.accessToken,
    user: userPayload,
    accounts: mappedAccounts,
    data: {
      accessToken: session.accessToken,
      user: userPayload,
      accounts: mappedAccounts,
    },
  });
});

// ─── ADD ACCOUNT ──────────────────────────────────────────────────────────────
exports.addAccount = catchAsync(async (req, res) => {
  const currentUser = req.user;
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    throw new AppError("Name, email, and password are required.", 400);
  }

  const phoneCount = await PatientUser.countDocuments({ phone: currentUser.phone });
  if (phoneCount >= 3) {
    throw new AppError("Maximum account limit reached for this mobile number.", 409);
  }

  const emailExists = await PatientUser.findOne({ email: email.toLowerCase() });
  if (emailExists) {
    throw new AppError("An account with this email already exists.", 409);
  }

  const newAccount = await PatientUser.create({
    name: String(name).trim(),
    email: email.toLowerCase().trim(),
    password,
    phone: currentUser.phone,
    isMobileVerified: true,
    accountIndex: phoneCount,
    accountLabel: "",
    lastActiveAt: Date.now(),
  });

  // Grant welcome credits for the new linked account
  await grantWelcomeCredits(newAccount);

  const session = await createPatientSession({
    patient: newAccount,
    req,
    res,
    action: "PATIENT_ADD_ACCOUNT",
    description: `Added and switched to new account: ${newAccount.email}`,
    ip: req.ip,
  });

  if (session.limitReached) {
    // If limit reached, delete the newly created account so the database isn't left in a bad state
    await PatientUser.deleteOne({ _id: newAccount._id });
    return res.status(400).json({
      success: false,
      code: "MAX_DEVICES_REACHED",
      message: "Maximum device limit reached. Please logout from an existing device to continue.",
      sessions: session.sessions,
    });
  }

  // Clear old account's refresh token
  currentUser.refreshToken = undefined;
  await PatientUser.updateOne({ _id: currentUser._id }, { $unset: { refreshToken: "" } });

  // Delete the old session from the DB as we are replacing it with newAccount's session
  if (req.sessionToken) {
    await PatientSession.deleteOne({ sessionToken: req.sessionToken });
  }

  const accountsList = await PatientUser.find(
    { phone: newAccount.phone },
    "name email avatar age gender accountIndex accountLabel createdAt"
  ).sort({ accountIndex: 1 }).lean();

  const mappedAccounts = accountsList.map((a) => ({
    id: String(a._id),
    name: a.name,
    email: a.email,
    avatar: a.avatar || null,
    age: a.age || null,
    gender: a.gender || null,
    accountIndex: a.accountIndex ?? 0,
    accountLabel: a.accountLabel || "",
    isActive: String(a._id) === String(newAccount._id),
  }));

  const userPayload = {
    id: String(newAccount._id),
    name: newAccount.name,
    email: newAccount.email,
    phone: newAccount.phone,
    avatar: null,
    age: null,
    gender: null,
    accountIndex: newAccount.accountIndex,
    accountLabel: newAccount.accountLabel,
  };

  res.status(201).json({
    success: true,
    accessToken: session.accessToken,
    user: userPayload,
    accounts: mappedAccounts,
    data: {
      accessToken: session.accessToken,
      user: userPayload,
      accounts: mappedAccounts,
    },
  });
});

// ─── UPDATE ACCOUNT LABEL ─────────────────────────────────────────────────────
exports.updateAccountLabel = catchAsync(async (req, res) => {
  const { label } = req.body;
  if (typeof label !== "string") throw new AppError("Label is required.", 400);

  req.user.accountLabel = label.trim().slice(0, 40);
  await req.user.save({ validateBeforeSave: false });

  res.status(200).json({ success: true, data: { accountLabel: req.user.accountLabel } });
});

// ─── HEARTBEAT ────────────────────────────────────────────────────────────────
exports.heartbeat = catchAsync(async (req, res) => {
  // lastActiveAt is already updated by the protectPatient middleware
  res.status(200).json({ success: true });
});

// ─── SESSIONS ─────────────────────────────────────────────────────────────────
exports.getSessions = catchAsync(async (req, res, next) => {
  // Delete expired sessions first
  await PatientSession.deleteMany({ expiresAt: { $lt: new Date() } });

  const sessions = await PatientSession.find({ userId: req.user._id })
    .sort({ lastActive: -1 })
    .lean();

  const data = sessions.map((s) => ({
    deviceId: s.deviceId,
    deviceName: s.deviceName,
    deviceType: s.deviceType,
    browserVersion: s.browserVersion,
    loginTime: s.loginTime,
    lastActive: s.lastActive,
    isCurrentDevice: s.sessionToken === req.sessionToken,
  }));

  res.status(200).json({
    success: true,
    data,
  });
});

exports.terminateSession = catchAsync(async (req, res, next) => {
  const { deviceId } = req.params;

  const session = await PatientSession.findOne({
    userId: req.user._id,
    deviceId,
  });

  if (!session) {
    return next(new AppError("Session not found.", 404));
  }

  await PatientSession.deleteOne({ _id: session._id });

  // Send system notification
  const NotificationLog = require("../models/NotificationLog");
  try {
    await NotificationLog.create({
      patientUserId: req.user._id,
      title: "Device Session Terminated",
      body: `Your session on device '${session.deviceName}' was removed.`,
      status: "sent",
      category: "system",
      actionUrl: "/dashboard",
    });
  } catch (err) {
    console.error("Failed to create termination notification:", err);
  }

  // Record audit activity
  await recordActivity({
    action: "PATIENT_SESSION_REMOVED",
    entity: "PatientUser",
    entityId: req.user._id,
    description: `Session on device '${session.deviceName}' (${session.deviceId}) was removed.`,
    ip: req.ip,
  });

  res.status(200).json({
    success: true,
    message: "Session terminated successfully.",
  });
});
