const User = require("../models/User");
const Hospital = require("../models/Hospital");
const PlatformAd = require("../models/PlatformAd");
const logger = require("../utils/logger");
const sendEmail = require("../utils/sendEmail");
const { buildDemoExpiryWarningEmail, buildDemoExpiryWarningEmailForHospital } = require("../utils/emailTemplates");
const { DEMO_WARNING_DAYS, isDemoExpired } = require("../utils/hospitalAccess");
const { deleteMediaObject } = require("../utils/mediaStorage");

const DAY_MS = 24 * 60 * 60 * 1000;

const sendDemoExpiryEmails = async () => {
  const { buildDemoExpiryEmail } = require("../utils/emailTemplates");
  const now = new Date();
  const oneDayMs = 24 * 60 * 60 * 1000;

  const hospitals = await Hospital.find({
    subscriptionType: "demo",
    isArchived: { $ne: true }
  });

  for (const hospital of hospitals) {
    const expiry = hospital.demoExpiryDate || hospital.demoExpiresAt;
    if (!expiry) continue;

    const timeDiff = new Date(expiry).getTime() - now.getTime();
    const daysRemaining = Math.ceil(timeDiff / oneDayMs);

    // 1. 7 Days Before Expiry
    if (daysRemaining <= 7 && daysRemaining > 6 && !hospital.expiryEmail7DaysSent) {
      if (hospital.email) {
        try {
          const emailData = buildDemoExpiryEmail({
            hospitalName: hospital.name,
            hospitalCode: hospital.hospitalCode,
            type: "warning-7",
            expiresAt: expiry,
          });
          await sendEmail({
            email: hospital.email,
            subject: emailData.subject,
            message: emailData.message,
            html: emailData.html,
          });
          hospital.expiryEmail7DaysSent = true;
          await hospital.save({ validateBeforeSave: false });
          logger.info(`Sent 7-day demo expiry warning to ${hospital.email} for ${hospital.name}`);
        } catch (err) {
          logger.error(`Error sending 7-day demo email to ${hospital.name}: ${err.message}`);
        }
      }
    }

    // 2. 3 Days Before Expiry
    if (daysRemaining <= 3 && daysRemaining > 2 && !hospital.expiryEmail3DaysSent) {
      if (hospital.email) {
        try {
          const emailData = buildDemoExpiryEmail({
            hospitalName: hospital.name,
            hospitalCode: hospital.hospitalCode,
            type: "reminder-3",
            expiresAt: expiry,
          });
          await sendEmail({
            email: hospital.email,
            subject: emailData.subject,
            message: emailData.message,
            html: emailData.html,
          });
          hospital.expiryEmail3DaysSent = true;
          await hospital.save({ validateBeforeSave: false });
          logger.info(`Sent 3-day demo expiry warning to ${hospital.email} for ${hospital.name}`);
        } catch (err) {
          logger.error(`Error sending 3-day demo email to ${hospital.name}: ${err.message}`);
        }
      }
    }

    // 3. 1 Day Before Expiry
    if (daysRemaining <= 1 && daysRemaining > 0 && !hospital.expiryEmail1DaySent) {
      if (hospital.email) {
        try {
          const emailData = buildDemoExpiryEmail({
            hospitalName: hospital.name,
            hospitalCode: hospital.hospitalCode,
            type: "final-1",
            expiresAt: expiry,
          });
          await sendEmail({
            email: hospital.email,
            subject: emailData.subject,
            message: emailData.message,
            html: emailData.html,
          });
          hospital.expiryEmail1DaySent = true;
          await hospital.save({ validateBeforeSave: false });
          logger.info(`Sent 1-day demo expiry warning to ${hospital.email} for ${hospital.name}`);
        } catch (err) {
          logger.error(`Error sending 1-day demo email to ${hospital.name}: ${err.message}`);
        }
      }
    }

    // 4. On Expiry (daysRemaining <= 0)
    if (daysRemaining <= 0 && !hospital.expiryEmail0DaySent) {
      if (hospital.email) {
        try {
          const emailData = buildDemoExpiryEmail({
            hospitalName: hospital.name,
            hospitalCode: hospital.hospitalCode,
            type: "expired-0",
            expiresAt: expiry,
          });
          await sendEmail({
            email: hospital.email,
            subject: emailData.subject,
            message: emailData.message,
            html: emailData.html,
          });
          hospital.expiryEmail0DaySent = true;
          await hospital.save({ validateBeforeSave: false });
          logger.info(`Sent demo expired notification to ${hospital.email} for ${hospital.name}`);
        } catch (err) {
          logger.error(`Error sending expired demo email to ${hospital.name}: ${err.message}`);
        }
      }
    }
  }
};

const suspendExpiredDemoHospitals = async () => {
  const now = new Date();
  const hospitals = await Hospital.find({
    subscriptionType: "demo",
    status: "Active",
    $or: [
      { demoExpiryDate: { $lte: now } },
      { demoExpiresAt: { $lte: now } }
    ]
  });

  for (const hospital of hospitals) {
    hospital.subscriptionStatus = "expired";
    hospital.status = "Inactive";
    hospital.demoExpiredNotifiedAt = new Date();
    await hospital.save({ validateBeforeSave: false });

    await User.updateMany(
      { hospitalId: hospital._id },
      { $set: { refreshToken: null, status: "Inactive" } }
    );

    logger.info(`Suspended expired demo hospital: ${hospital.name} (${hospital._id})`);
  }
};

const purgeSoftDeletedHospitals = async () => {
  const mongoose = require("mongoose");
  const Doctor = require("../models/Doctor");
  const Staff = require("../models/Staff");
  const Patient = require("../models/Patient");
  const PatientUser = require("../models/PatientUser");
  const PatientSession = require("../models/PatientSession");
  const Appointment = require("../models/Appointment");
  const Prescription = require("../models/Prescription");
  const Report = require("../models/Report");
  const AppointmentNotification = require("../models/AppointmentNotification");
  const NotificationLog = require("../models/NotificationLog");
  const Department = require("../models/Department");
  const Receipt = require("../models/Receipt");
  const ReceiptTemplate = require("../models/ReceiptTemplate");
  const HospitalAuditLog = require("../models/HospitalAuditLog");
  
  const { deletePrescriptionObject } = require("../utils/prescriptionStorage");
  const { deleteReportObject } = require("../utils/reportStorage");

  const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const hospitals = await Hospital.find({
    isArchived: true,
    archivedAt: { $lte: cutoffDate }
  });

  if (!hospitals.length) return;

  logger.info(`Found ${hospitals.length} archived hospital(s) ready for permanent cleanup.`);

  for (const hospital of hospitals) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const hospitalId = hospital._id;
      const s3KeysToDelete = [];

      if (hospital.logo?.key) {
        s3KeysToDelete.push({ type: "media", key: hospital.logo.key });
      }

      const prescriptions = await Prescription.find({ hospitalId }).select("document.key").lean();
      for (const presc of prescriptions) {
        if (presc.document?.key) {
          s3KeysToDelete.push({ type: "prescription", key: presc.document.key });
        }
      }

      const patients = await Patient.find({ hospitalId }).select("email phone").lean();
      const patientEmails = patients.map(p => p.email).filter(Boolean);
      const patientPhones = patients.map(p => p.phone).filter(Boolean);

      const patientUsers = await PatientUser.find({
        $or: [
          { email: { $in: patientEmails } },
          { phone: { $in: patientPhones } }
        ]
      }).select("_id").lean();
      const patientUserIds = patientUsers.map(pu => pu._id);

      const reports = await Report.find({ userId: { $in: patientUserIds } }).select("s3Key").lean();
      for (const rep of reports) {
        if (rep.s3Key) {
          s3KeysToDelete.push({ type: "report", key: rep.s3Key });
        }
      }

      // MongoDB cleanup within transaction
      await User.deleteMany({ hospitalId }, { session });
      await Doctor.deleteMany({ hospitalId }, { session });
      await Staff.deleteMany({ hospitalId }, { session });
      await Patient.deleteMany({ hospitalId }, { session });
      await Appointment.deleteMany({ hospitalId }, { session });
      await Prescription.deleteMany({ hospitalId }, { session });
      await Report.deleteMany({ userId: { $in: patientUserIds } }, { session });
      await PatientUser.deleteMany({ _id: { $in: patientUserIds } }, { session });
      await PatientSession.deleteMany({ patientUserId: { $in: patientUserIds } }, { session });
      await AppointmentNotification.deleteMany({ hospitalId }, { session });
      await NotificationLog.deleteMany({ patientUserId: { $in: patientUserIds } }, { session });
      await Department.deleteMany({ hospitalId }, { session });
      await Receipt.deleteMany({ hospitalId }, { session });
      await ReceiptTemplate.deleteMany({ hospitalId }, { session });
      await HospitalAuditLog.deleteMany({ hospitalId }, { session });
      await Hospital.deleteOne({ _id: hospitalId }, { session });

      await session.commitTransaction();
      session.endSession();

      logger.info(`Database records deleted for hospital ${hospital.name} (${hospitalId}). Initiating S3 asset cleanup...`);

      // S3 cleanup
      for (const asset of s3KeysToDelete) {
        try {
          if (asset.type === "media") {
            await deleteMediaObject(asset.key);
          } else if (asset.type === "prescription") {
            await deletePrescriptionObject(asset.key);
          } else if (asset.type === "report") {
            await deleteReportObject(asset.key);
          }
          logger.info(`Deleted S3 asset: ${asset.key} (${asset.type})`);
        } catch (s3Err) {
          logger.warn(`Failed to delete S3 asset ${asset.key}: ${s3Err.message}`);
        }
      }

      logger.info(`Successfully completed permanent cleanup for hospital: ${hospital.name}`);
    } catch (err) {
      await session.abortTransaction();
      session.endSession();
      logger.error(`Failed permanent cleanup for hospital ${hospital.name}: ${err.message}`);
    }
  }
};

const purgeExpiredAds = async () => {
  const expiredAds = await PlatformAd.find({
    expiresAt: { $lte: new Date() },
  });

  for (const ad of expiredAds) {
    if (ad.poster?.key) {
      try {
        await deleteMediaObject(ad.poster.key);
      } catch (error) {
        logger.warn(`Failed deleting ad poster ${ad.poster.key}: ${error.message}`);
      }
    }

    await PlatformAd.findByIdAndDelete(ad._id);
    logger.info(`Removed expired platform ad ${ad._id}`);
  }
};

const cleanExpiredLogsAndNotifications = async () => {
  try {
    const Activity = require("../models/Activity");
    const NotificationLog = require("../models/NotificationLog");
    const AppointmentNotification = require("../models/AppointmentNotification");
    const HospitalAuditLog = require("../models/HospitalAuditLog");

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [activityResult, notifResult, appNotifResult, auditResult] = await Promise.all([
      Activity.deleteMany({ createdAt: { $lte: sevenDaysAgo } }),
      NotificationLog.deleteMany({ createdAt: { $lte: sevenDaysAgo } }),
      AppointmentNotification.deleteMany({ createdAt: { $lte: sevenDaysAgo } }),
      HospitalAuditLog.deleteMany({ createdAt: { $lte: sevenDaysAgo } }),
    ]);

    logger.info(
      `Cleaned up expired logs and notifications: deleted ${activityResult.deletedCount} activity logs, ` +
      `${notifResult.deletedCount} notification logs, ${appNotifResult.deletedCount} appointment notifications, ` +
      `and ${auditResult.deletedCount} hospital audit logs older than 7 days.`
    );
  } catch (err) {
    logger.error(`Failed to clean up expired logs and notifications: ${err.message}`);
  }
};

const runScheduledTasks = async () => {
  try {
    await sendDemoExpiryEmails();
    await suspendExpiredDemoHospitals();
    await purgeSoftDeletedHospitals();
    await purgeExpiredAds();
    await cleanExpiredLogsAndNotifications();
  } catch (error) {
    logger.error(`Scheduled task failure: ${error.message}`);
  }
};

// ─── Medicine Reminder Dispatcher (runs every 60 seconds) ─────────────
const dispatchMedicineReminders = async () => {
  try {
    const MedicineReminder = require("../models/MedicineReminder");
    const NotificationLog = require("../models/NotificationLog");
    const PatientUser = require("../models/PatientUser");
    const { sendPushNotification } = require("../utils/pushNotifications");

    // Get current time in Asia/Kolkata
    const nowIST = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
    );
    const hours = String(nowIST.getHours()).padStart(2, "0");
    const minutes = String(nowIST.getMinutes()).padStart(2, "0");
    const currentTime = `${hours}:${minutes}`;
    const currentDayOfWeek = nowIST.getDay(); // 0=Sun … 6=Sat

    // Today's date boundaries in IST
    const todayStart = new Date(nowIST);
    todayStart.setHours(0, 0, 0, 0);

    // 1. Find reminders that match current time
    const reminders = await MedicineReminder.find({
      status: "active",
      startDate: { $lte: new Date() },
      $or: [
        { endDate: { $gte: todayStart } },
        { endDate: null },
      ],
      times: currentTime,
    })
      .select("patientUserId prescriptionId medicineName dosage times doctorName repeatType repeatDays repeatIntervalHours")
      .lean();

    if (reminders.length > 0) {
      logger.info(
        `[MedicineReminder] Found ${reminders.length} reminder(s) for ${currentTime} IST`
      );
    }

    // 2. Process each reminder
    for (const reminder of reminders) {
      // ── Repeat type filtering ───────────────────────────────────────────
      // Skip if this day-of-week is not in the allowed days for weekly/custom_days
      const repeatType = reminder.repeatType || "daily";
      if (["weekly", "custom_days"].includes(repeatType)) {
        const repeatDays = reminder.repeatDays || [];
        if (repeatDays.length > 0 && !repeatDays.includes(currentDayOfWeek)) {
          continue; // Not scheduled for today
        }
      }

      // Build scheduledFor timestamp (today + matched time)
      const scheduledFor = new Date(todayStart);
      scheduledFor.setHours(parseInt(hours, 10), parseInt(minutes, 10), 0, 0);

      // Check for duplicate (already sent this reminder at this time today)
      const exists = await NotificationLog.findOne({
        reminderId: reminder._id,
        scheduledFor,
      }).lean();

      if (exists) continue;

      // Get patient FCM token
      const patient = await PatientUser.findById(reminder.patientUserId)
        .select("fcmToken name")
        .lean();

      const title = `💊 Medicine Time: ${reminder.medicineName}`;
      const doctorLine = reminder.doctorName
        ? `Prescribed by Dr. ${reminder.doctorName}`
        : "Your custom reminder";
      const body = `Dosage: ${reminder.dosage} · ${doctorLine}`;

      if (!patient?.fcmToken) {
        // Log as skipped — no FCM token
        await NotificationLog.create({
          reminderId: reminder._id,
          patientUserId: reminder.patientUserId,
          scheduledFor,
          sentAt: new Date(),
          status: "skipped",
          errorMessage: "No FCM token registered",
          title,
          body,
          category: "medicine_reminder",
          actionUrl: "/dashboard/reminders",
        });
        continue;
      }

      // Send FCM push with full alarm data
      try {
        const result = await sendPushNotification(patient.fcmToken, {
          title,
          body,
          data: {
            type: "medicine_reminder",
            category: "medicine_reminder",
            channelId: "medicine_alarm_channel",
            channel_id: "medicine_alarm_channel",
            reminderId: String(reminder._id),
            prescriptionId: String(reminder.prescriptionId || ""),
            medicineName: String(reminder.medicineName || ""),
            dosage: String(reminder.dosage || ""),
            doctorName: String(reminder.doctorName || ""),
            scheduledTime: currentTime,
            url: "/dashboard/reminders",
          },
        });

        await NotificationLog.create({
          reminderId: reminder._id,
          patientUserId: reminder.patientUserId,
          scheduledFor,
          sentAt: new Date(),
          status: "sent",
          fcmMessageId: (result && typeof result === "object" ? result.messageId : result) || null,
          title,
          body,
          category: "medicine_reminder",
          actionUrl: "/dashboard/reminders",
        });
      } catch (sendError) {
        await NotificationLog.create({
          reminderId: reminder._id,
          patientUserId: reminder.patientUserId,
          scheduledFor,
          sentAt: new Date(),
          status: "failed",
          errorMessage: sendError.message,
          title,
          body,
          category: "medicine_reminder",
          actionUrl: "/dashboard/reminders",
        });
        logger.warn(
          `[MedicineReminder] FCM send failed for ${reminder._id}: ${sendError.message}`
        );
      }
    }

    // 3. Mark expired reminders as completed (only those with an explicit endDate)
    const expiredResult = await MedicineReminder.updateMany(
      { status: "active", endDate: { $lt: todayStart, $ne: null } },
      { $set: { status: "completed" } }
    );

    if (expiredResult.modifiedCount > 0) {
      logger.info(
        `[MedicineReminder] Marked ${expiredResult.modifiedCount} expired reminder(s) as completed.`
      );
    }
  } catch (error) {
    logger.error(`[MedicineReminder] Dispatch failure: ${error.message}`);
  }
};

const startScheduledTasks = () => {
  const intervalMs = Number(process.env.SCHEDULED_TASK_INTERVAL_MS) || 60 * 60 * 1000;

  // Hourly tasks: demo warnings, expired hospitals, expired ads
  void runScheduledTasks();
  setInterval(() => {
    void runScheduledTasks();
  }, intervalMs);

  // Medicine reminder dispatcher: runs every 60 seconds
  setInterval(() => {
    void dispatchMedicineReminders();
  }, 60 * 1000);

  logger.info(`Scheduled tasks enabled (interval ${intervalMs}ms).`);
  logger.info("Medicine reminder dispatcher enabled (interval 60s).");
};

module.exports = {
  runScheduledTasks,
  startScheduledTasks,
  dispatchMedicineReminders,
};

