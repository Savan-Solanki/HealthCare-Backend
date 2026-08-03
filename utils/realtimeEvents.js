const { getIO } = require("../config/socketio");
const { v4: uuidv4 } = require("uuid");
const logger = require("../utils/logger");

const EVENTS = {
  PRESCRIPTION_CREATED: "prescription:created",
  PRESCRIPTION_UPDATED: "prescription:updated",
  APPOINTMENT_CREATED: "appointment:created",
  APPOINTMENT_UPDATED: "appointment:updated",
  APPOINTMENT_CANCELLED: "appointment:cancelled",
  REPORT_UPLOADED: "report:uploaded",
  PROFILE_UPDATED: "profile:updated",
  REMINDER_CREATED: "reminder:created",
  REMINDER_UPDATED: "reminder:updated",
  NOTIFICATION_NEW: "notification:new",
  RECORD_UPDATED: "record:updated",
  ADMISSION_CREATED: "admission:created",
  ADMISSION_UPDATED: "admission:updated",
  ADMISSION_STATUS_CHANGED: "admission:status_changed",
  PATIENT_DISCHARGED: "patient:discharged",
};

const emitToPatient = (patientUserId, event, data) => {
  const io = getIO();
  if (!io) {
    logger.warn("Socket.IO server not initialized. Skipping real-time patient broadcast.");
    return;
  }

  const payload = {
    ...data,
    timestamp: new Date().toISOString(),
    syncId: uuidv4(),
  };

  io.of("/patient").to(`user:${patientUserId}`).emit(event, payload);
  logger.info(`Emitted real-time patient event ${event} to user:${patientUserId}`);
};

const emitToHospital = (hospitalId, event, data) => {
  const io = getIO();
  if (!io) {
    logger.warn("Socket.IO server not initialized. Skipping real-time hospital broadcast.");
    return;
  }

  const payload = {
    ...data,
    timestamp: new Date().toISOString(),
  };

  io.of("/staff").to(`hospital:${hospitalId}`).emit(event, payload);
  logger.info(`Emitted real-time staff event ${event} to hospital:${hospitalId}`);
};

const emitToHospitalRole = (hospitalId, role, event, data) => {
  const io = getIO();
  if (!io) {
    logger.warn("Socket.IO server not initialized. Skipping real-time staff broadcast.");
    return;
  }

  const payload = {
    ...data,
    timestamp: new Date().toISOString(),
  };

  io.of("/staff").to(`hospital:${hospitalId}:role:${role}`).emit(event, payload);
  logger.info(`Emitted real-time staff event ${event} to hospital:${hospitalId}:role:${role}`);
};

const emitSlotsUpdated = (hospitalId, doctorId, date) => {
  const io = getIO();
  if (!io) return;
  const payload = {
    doctorId: String(doctorId),
    date,
    timestamp: new Date().toISOString(),
  };
  io.of("/patient").emit("slots:updated", payload);
  io.of("/staff").to(`hospital:${hospitalId}`).emit("slots:updated", payload);
};

module.exports = {
  EVENTS,
  emitToPatient,
  emitToHospital,
  emitToHospitalRole,
  emitSlotsUpdated,
};
