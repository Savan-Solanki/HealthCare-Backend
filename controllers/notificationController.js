const jwt = require("jsonwebtoken");

const AppointmentNotification = require("../models/AppointmentNotification");
const Doctor = require("../models/Doctor");
const User = require("../models/User");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const {
  broadcastNotificationDismissed,
  mapNotification,
  registerNotificationClient,
  writeSse,
} = require("../utils/appointmentNotifications");

const allowedRoles = ["Hospital Admin", "Doctor", "Receptionist"];

const resolveCookieToken = (req) =>
  req.cookies?.ha_refreshToken ||
    req.cookies?.re_refreshToken ||
    req.cookies?.dr_refreshToken ||
    req.cookies?.sa_refreshToken ||
    null;

const resolveBearerToken = (req) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.split(" ")[1];
};

const resolveStreamUser = async (req) => {
  const accessToken = resolveBearerToken(req) || req.query.token;

  if (accessToken) {
    const decoded = jwt.verify(accessToken, process.env.JWT_SECRET);
    return User.findById(decoded.id);
  }

  const refreshToken = resolveCookieToken(req);
  if (!refreshToken) return null;

  const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
  const user = await User.findById(decoded.id).select("+refreshToken");

  if (!user || user.refreshToken !== refreshToken) return null;
  return user;
};

const getDoctorNotificationContext = async (user) => {
  if (!user.hospitalId) {
    throw new AppError("Doctor account is not assigned to a hospital.", 403);
  }

  const doctor = await Doctor.findOne({
    hospitalId: user.hospitalId,
    $or: [{ userId: user._id }, { email: user.email }],
  }).select("_id firstName lastName");

  const doctorName = doctor
    ? [doctor.firstName, doctor.lastName].filter(Boolean).join(" ").trim()
    : user.name;

  return {
    doctor,
    doctorName,
    filter: {
      hospitalId: user.hospitalId,
      targetRole: "Doctor",
      $or: [
        { doctorUserId: user._id },
        ...(doctor?._id ? [{ doctorId: doctor._id }] : []),
        { doctorName: new RegExp(`^\\s*${doctorName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i") },
      ],
    },
  };
};

const getNotificationContext = async (user) => {
  if (!allowedRoles.includes(user.role)) {
    throw new AppError("You do not have permission to access notifications.", 403);
  }

  if (user.role === "Hospital Admin" || user.role === "Receptionist") {
    if (!user.hospitalId) {
      throw new AppError(`${user.role} is not assigned to a hospital.`, 403);
    }

    return {
      doctor: null,
      doctorName: null,
      filter: {
        hospitalId: user.hospitalId,
        targetRole: user.role,
      },
    };
  }

  return getDoctorNotificationContext(user);
};

const buildClientMeta = async (user, res) => {
  const context = await getNotificationContext(user);

  return {
    doctorId: context.doctor?._id || null,
    doctorName: context.doctorName,
    hospitalId: user.hospitalId,
    res,
    role: user.role,
    userId: user._id,
  };
};

exports.getNotifications = catchAsync(async (req, res) => {
  const { filter } = await getNotificationContext(req.user);
  const notifications = await AppointmentNotification.find(filter)
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  res.status(200).json({
    success: true,
    total: notifications.length,
    data: notifications.map(mapNotification),
  });
});

exports.dismissNotification = catchAsync(async (req, res, next) => {
  const { filter } = await getNotificationContext(req.user);
  const notification = await AppointmentNotification.findOneAndDelete({
    ...filter,
    _id: req.params.id,
  }).lean();

  if (!notification) {
    return next(new AppError("Notification not found.", 404));
  }

  broadcastNotificationDismissed(notification);

  res.status(200).json({
    success: true,
    message: "Notification dismissed.",
  });
});

exports.dismissAppointmentNotifications = catchAsync(async (req, res) => {
  const { filter } = await getNotificationContext(req.user);
  const notifications = await AppointmentNotification.find({
    ...filter,
    appointmentId: req.params.appointmentId,
  }).lean();

  if (notifications.length) {
    await AppointmentNotification.deleteMany({
      ...filter,
      appointmentId: req.params.appointmentId,
    });
    notifications.forEach(broadcastNotificationDismissed);
  }

  res.status(200).json({
    success: true,
    message: "Appointment notifications dismissed.",
  });
});

exports.streamNotifications = async (req, res) => {
  try {
    const user = await resolveStreamUser(req);

    if (!user || !allowedRoles.includes(user.role)) {
      res.status(401).json({ success: false, message: "You are not logged in." });
      return;
    }

    const client = await buildClientMeta(user, res);

    res.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    });

    writeSse(res, "connected", { connected: true });

    const unregister = registerNotificationClient(client);
    const keepAlive = setInterval(() => {
      res.write(": keep-alive\n\n");
    }, 25000);

    req.on("close", () => {
      clearInterval(keepAlive);
      unregister();
      res.end();
    });
  } catch {
    res.status(401).json({ success: false, message: "Unable to open notification stream." });
  }
};

const { sendPushNotification } = require("../utils/pushNotifications");

exports.registerFcmToken = catchAsync(async (req, res, next) => {
  const { fcmToken } = req.body;

  // req.user is set by protectPatient middleware
  if (!req.user) {
    return next(new AppError("User not found.", 404));
  }

  if (fcmToken) {
    req.user.fcmToken = fcmToken;

    if (!req.user.fcmTokens) {
      req.user.fcmTokens = [];
    }

    // Filter out existing token if present, then push to the end (most recent)
    req.user.fcmTokens = req.user.fcmTokens.filter((token) => token !== fcmToken);
    req.user.fcmTokens.push(fcmToken);

    // Keep maximum 5 tokens
    if (req.user.fcmTokens.length > 5) {
      req.user.fcmTokens = req.user.fcmTokens.slice(-5);
    }
    console.log("FCM Token Saved For User:", req.user._id);
  }

  await req.user.save({ validateBeforeSave: false });

  res.status(200).json({
    success: true,
    message: "FCM token registered successfully.",
  });
});

exports.sendTestNotification = catchAsync(async (req, res, next) => {
  if (!req.user) {
    return next(new AppError("User not found.", 404));
  }

  const { title, body, isMedicineReminder } = req.body;

  const targetToken = req.user.fcmToken;
  if (!targetToken) {
    return next(new AppError("No FCM token registered for this user.", 400));
  }

  const payload = {
    title: title || "Test Notification",
    body: body || "This is a diagnostic push notification.",
    data: {
      category: isMedicineReminder ? "medicine_reminder" : "test",
      channelId: isMedicineReminder ? "medicine_channel_v3" : "default_channel_v2",
      sound: isMedicineReminder ? "default" : "",
      type: isMedicineReminder ? "medicine_reminder" : "test",
      channel_id: isMedicineReminder ? "medicine_channel_v3" : "default_channel_v2",
      url: "/debug/notifications",
      sentAt: new Date().toISOString(),
    },
  };

  const result = await sendPushNotification(targetToken, payload);

  res.status(200).json({
    success: true,
    message: "Test notification sent.",
    result,
  });
});

