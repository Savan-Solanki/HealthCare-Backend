const AppointmentNotification = require("../models/AppointmentNotification");
const NotificationLog = require("../models/NotificationLog");

const clients = new Set();

const normalizeName = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^dr\.?\s+/i, "")
    .replace(/\s+/g, " ");

const buildDoctorName = (doctor) =>
  [doctor?.firstName, doctor?.lastName].filter(Boolean).join(" ").trim();

const mapNotification = (notification) => ({
  id: String(notification._id),
  appointmentId: String(notification.appointmentId),
  hospitalId: String(notification.hospitalId),
  targetRole: notification.targetRole,
  doctorId: notification.doctorId ? String(notification.doctorId) : null,
  doctorUserId: notification.doctorUserId ? String(notification.doctorUserId) : null,
  doctorName: notification.doctorName || null,
  patientName: notification.patientName,
  department: notification.department || null,
  appointmentDate: notification.appointmentDate,
  appointmentTime: notification.appointmentTime || null,
  title: notification.title,
  message: notification.message,
  actionUrl: notification.actionUrl,
  createdAt: notification.createdAt,
});

const notificationMatchesClient = (notification, client) => {
  if (!notification || !client) return false;
  if (String(notification.hospitalId) !== String(client.hospitalId)) return false;

  if (client.role === "Hospital Admin") {
    return notification.targetRole === "Hospital Admin";
  }

  if (client.role === "Receptionist") {
    return notification.targetRole === "Receptionist";
  }

  if (client.role === "Doctor") {
    if (notification.targetRole !== "Doctor") return false;

    const doctorUserId = notification.doctorUserId ? String(notification.doctorUserId) : null;
    const doctorId = notification.doctorId ? String(notification.doctorId) : null;

    return (
      (doctorUserId && doctorUserId === String(client.userId)) ||
      (doctorId && client.doctorId && doctorId === String(client.doctorId)) ||
      normalizeName(notification.doctorName) === normalizeName(client.doctorName)
    );
  }

  return false;
};

const writeSse = (res, event, data) => {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};

const registerNotificationClient = (client) => {
  clients.add(client);

  return () => {
    clients.delete(client);
  };
};

const broadcastNotification = (notification) => {
  const payload = mapNotification(notification);

  clients.forEach((client) => {
    if (!notificationMatchesClient(notification, client)) return;
    writeSse(client.res, "appointment-notification", payload);
  });
};

const broadcastNotificationDismissed = (notification) => {
  if (!notification) return;

  const payload = {
    id: String(notification._id),
    appointmentId: String(notification.appointmentId),
  };

  clients.forEach((client) => {
    if (!notificationMatchesClient(notification, client)) return;
    writeSse(client.res, "appointment-notification-dismissed", payload);
  });
};

const createAppointmentBookingNotifications = async ({
  appointment,
  doctor,
  hospital,
  emitRealtime = true,
}) => {
  const doctorName = appointment.doctorName || buildDoctorName(doctor);
  const appointmentDate = appointment.appointmentDate;
  const appointmentTime = appointment.appointmentTime || "--:--";
  const department = appointment.department || doctor?.department || doctor?.specialization || "General care";
  const patientName = appointment.patientName;
  const baseNotification = {
    appointmentId: appointment._id,
    hospitalId: appointment.hospitalId,
    doctorId: doctor?._id || null,
    doctorUserId: doctor?.userId || null,
    doctorName,
    patientName,
    department,
    appointmentDate,
    appointmentTime,
  };

  const notifications = await AppointmentNotification.create([
    {
      ...baseNotification,
      targetRole: "Hospital Admin",
      title: "New appointment booked",
      message: `${patientName} booked with Dr. ${doctorName} at ${appointmentTime}.`,
      actionUrl: "/hospital-admin/appointments",
    },
    {
      ...baseNotification,
      targetRole: "Doctor",
      title: "New patient appointment",
      message: `${patientName} booked an appointment for ${department} at ${appointmentTime}.`,
      actionUrl: "/doctor/appointments",
    },
    {
      ...baseNotification,
      targetRole: "Receptionist",
      title: "New appointment booked",
      message: `${patientName} booked with Dr. ${doctorName} at ${appointmentTime}.`,
      actionUrl: "/receptionist/appointments",
    },
  ]);

  notifications.forEach(broadcastNotification);

  if (emitRealtime) {
    try {
      const { emitToHospitalRole, EVENTS } = require("./realtimeEvents");
      const payload = appointment.toObject ? appointment.toObject() : appointment;
      emitToHospitalRole(appointment.hospitalId, "Receptionist", EVENTS.APPOINTMENT_CREATED, payload);
      emitToHospitalRole(appointment.hospitalId, "Hospital Admin", EVENTS.APPOINTMENT_CREATED, payload);
    } catch (err) {
      const logger = require("./logger");
      logger.warn(`Failed to emit Socket.IO events for new appointment: ${err.message}`);
    }
  }

  return notifications;
};

const createPatientAppointmentStatusNotification = async (appointment, status) => {
  if (!appointment?.patientUserId) return null;

  let title = "Appointment Update";
  let body = `Your appointment status with Dr. ${appointment.doctorName} is now ${status}.`;

  if (status === "Scheduled" || status === "Pending") {
    title = "Appointment Booked";
    body = `Your appointment with Dr. ${appointment.doctorName} is scheduled and pending doctor confirmation.`;
  } else if (status === "Confirmed") {
    title = "Appointment Confirmed";
    body = `Your appointment with Dr. ${appointment.doctorName} has been confirmed.`;
  } else if (status === "Completed") {
    title = "Appointment Completed";
    body = `Your appointment with Dr. ${appointment.doctorName} has been completed.`;
  } else if (status === "Cancelled") {
    title = "Appointment Cancelled";
    body = `Your appointment with Dr. ${appointment.doctorName} has been cancelled.`;
  }

  const notif = await NotificationLog.create({
    patientUserId: appointment.patientUserId,
    sentAt: new Date(),
    status: "sent",
    title,
    body,
    category: "appointment",
    actionUrl: "/dashboard/appointments",
  });

  try {
    const { emitToPatient, EVENTS } = require("./realtimeEvents");
    emitToPatient(appointment.patientUserId, EVENTS.NOTIFICATION_NEW, notif.toObject ? notif.toObject() : notif);
  } catch (err) {
    const logger = require("./logger");
    logger.warn(`Failed to emit Socket.IO notification event: ${err.message}`);
  }

  return notif;
};

const createPatientAppointmentConfirmationNotification = async (appointment) => {
  return createPatientAppointmentStatusNotification(appointment, "Confirmed");
};

const deleteAppointmentNotifications = async (appointmentId) => {
  const notifications = await AppointmentNotification.find({ appointmentId }).lean();

  if (notifications.length) {
    await AppointmentNotification.deleteMany({ appointmentId });
    notifications.forEach(broadcastNotificationDismissed);
  }
};

module.exports = {
  broadcastNotificationDismissed,
  createAppointmentBookingNotifications,
  createPatientAppointmentConfirmationNotification,
  createPatientAppointmentStatusNotification,
  deleteAppointmentNotifications,
  mapNotification,
  normalizeName,
  notificationMatchesClient,
  registerNotificationClient,
  writeSse,
};
