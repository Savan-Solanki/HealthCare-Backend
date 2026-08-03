const MedicineReminder = require("../models/MedicineReminder");
const logger = require("./logger");

const TIME_FORMAT = /^([01]\d|2[0-3]):[0-5]\d$/;

// Default reminder times when a custom time is not provided
const DEFAULT_TIMES = {
  morning: "08:00",
  afternoon: "12:30",
  night: "20:00",
};

/**
 * Parse a free-text duration string into an end Date.
 *
 * Supported formats:
 *   "7 days", "2 weeks", "1 month", "3 months", "15 days", "10" (plain number → days)
 *
 * Falls back to 7 days when the string cannot be parsed.
 *
 * @param {string} durationString - Human-readable duration, e.g. "7 days"
 * @param {Date}   [fromDate]     - Reference start date (defaults to now)
 * @returns {Date} The calculated end date
 */
const parseDuration = (durationString, fromDate) => {
  const base = fromDate instanceof Date && !isNaN(fromDate) ? new Date(fromDate) : new Date();
  const raw = String(durationString || "").trim().toLowerCase();

  // Match patterns like "7 days", "2 weeks", "1 month", or a bare number
  const match = raw.match(/^(\d+)\s*(day|days|week|weeks|month|months)?$/);

  if (!match) {
    // Unparseable — default to 7 days
    base.setDate(base.getDate() + 7);
    return base;
  }

  const amount = parseInt(match[1], 10) || 7;
  const unit = (match[2] || "day").replace(/s$/, ""); // normalize plural

  switch (unit) {
    case "week":
      base.setDate(base.getDate() + amount * 7);
      break;
    case "month":
      base.setMonth(base.getMonth() + amount);
      break;
    case "day":
    default:
      base.setDate(base.getDate() + amount);
      break;
  }

  return base;
};

/**
 * Build a validated HH:mm time value, falling back to a default.
 *
 * @param {string} customTime  - User-provided time string
 * @param {string} fallback    - Default HH:mm to use when customTime is invalid
 * @returns {string} A valid HH:mm string
 */
const resolveTime = (customTime, fallback) => {
  const cleaned = String(customTime || "").trim();
  return TIME_FORMAT.test(cleaned) ? cleaned : fallback;
};

/**
 * Generate MedicineReminder documents from a saved Prescription.
 *
 * Iterates over each medicine in the prescription, maps schedule booleans
 * (morning / afternoon / night) to HH:mm time arrays, computes the end date
 * from the duration field, and bulk-inserts the reminders.
 *
 * This function is intentionally non-throwing — errors are logged so that
 * prescription creation is never blocked by reminder failures.
 *
 * @param {Object} prescription - A saved Mongoose Prescription document
 * @returns {Promise<Array>}     The created MedicineReminder documents (or [])
 */
const generateRemindersFromPrescription = async (prescription) => {
  try {
    if (!prescription || !prescription.patientUserId) {
      logger.warn("generateRemindersFromPrescription: skipped — no patientUserId on prescription");
      return [];
    }

    const medicines = prescription.medicines || [];
    if (medicines.length === 0) {
      return [];
    }

    const startDate = prescription.prescriptionDate
      ? new Date(prescription.prescriptionDate)
      : new Date();

    const remindersToInsert = [];

    for (const medicine of medicines) {
      const schedule = medicine.schedule || {};
      const times = [];

      if (schedule.morning) {
        times.push(resolveTime(schedule.morningTime, DEFAULT_TIMES.morning));
      }
      if (schedule.afternoon) {
        times.push(resolveTime(schedule.afternoonTime, DEFAULT_TIMES.afternoon));
      }
      if (schedule.night) {
        times.push(resolveTime(schedule.nightTime, DEFAULT_TIMES.night));
      }

      // Skip medicines with no scheduled periods
      if (times.length === 0) {
        continue;
      }

      const endDate = parseDuration(medicine.duration, new Date(startDate));

      remindersToInsert.push({
        patientUserId: prescription.patientUserId,
        prescriptionId: prescription._id,
        type: "doctor_prescription",
        medicineName: String(medicine.medicineName || "").trim(),
        dosage: String(medicine.dosage || "").trim(),
        frequency: String(medicine.frequency || "").trim(),
        startDate,
        endDate,
        times,
        status: "active",
        repeatType: "daily",
        doctorName: String(prescription.doctorName || "").trim(),
        hospitalName: String(prescription.hospitalName || "").trim(),
      });
    }

    if (remindersToInsert.length === 0) {
      return [];
    }

    const createdReminders = await MedicineReminder.insertMany(remindersToInsert, {
      ordered: false,
    });

    logger.info(
      `Generated ${createdReminders.length} medicine reminder(s) for prescription ${prescription._id}`
    );

    return createdReminders;
  } catch (error) {
    logger.error(
      `Failed to generate medicine reminders for prescription ${prescription?._id}: ${error.message}`
    );
    return [];
  }
};

/**
 * Update medicine reminders when a doctor edits a prescription.
 *
 * Strategy:
 *   1. Cancel (status = "cancelled") all existing active/paused reminders
 *      linked to this prescriptionId.
 *   2. Generate fresh reminders from the updated prescription data.
 *
 * Non-throwing — errors are logged so prescription saves are never blocked.
 *
 * @param {Object} prescription - The updated, saved Mongoose Prescription document
 * @returns {Promise<Array>}     Newly created MedicineReminder documents (or [])
 */
const updateRemindersFromPrescription = async (prescription) => {
  try {
    if (!prescription || !prescription._id) {
      logger.warn("updateRemindersFromPrescription: skipped — no prescription id");
      return [];
    }

    // 1. Cancel existing reminders for this prescription
    const cancelResult = await MedicineReminder.updateMany(
      {
        prescriptionId: prescription._id,
        status: { $in: ["active", "paused"] },
      },
      { $set: { status: "cancelled" } }
    );

    if (cancelResult.modifiedCount > 0) {
      logger.info(
        `Cancelled ${cancelResult.modifiedCount} old reminder(s) for prescription ${prescription._id} before regenerating.`
      );
    }

    // 2. Only regenerate if the patient is linked and medicines exist
    if (!prescription.patientUserId) {
      logger.info(
        `updateRemindersFromPrescription: prescription ${prescription._id} has no patientUserId — skipping generation.`
      );
      return [];
    }

    // 3. Generate fresh reminders
    return await generateRemindersFromPrescription(prescription);
  } catch (error) {
    logger.error(
      `Failed to update medicine reminders for prescription ${prescription?._id}: ${error.message}`
    );
    return [];
  }
};

/**
 * Cancel all active/paused medicine reminders linked to a prescription
 * when that prescription is deleted.
 *
 * Non-throwing — errors are logged so prescription deletion is never blocked.
 *
 * @param {string|ObjectId} prescriptionId - The ID of the deleted prescription
 * @returns {Promise<number>} Count of cancelled reminders
 */
const cancelRemindersFromPrescription = async (prescriptionId) => {
  try {
    if (!prescriptionId) {
      logger.warn("cancelRemindersFromPrescription: skipped — no prescriptionId");
      return 0;
    }

    const result = await MedicineReminder.updateMany(
      {
        prescriptionId,
        status: { $in: ["active", "paused"] },
      },
      { $set: { status: "cancelled" } }
    );

    if (result.modifiedCount > 0) {
      logger.info(
        `Cancelled ${result.modifiedCount} reminder(s) for deleted prescription ${prescriptionId}.`
      );
    }

    return result.modifiedCount;
  } catch (error) {
    logger.error(
      `Failed to cancel medicine reminders for prescription ${prescriptionId}: ${error.message}`
    );
    return 0;
  }
};

module.exports = {
  parseDuration,
  generateRemindersFromPrescription,
  updateRemindersFromPrescription,
  cancelRemindersFromPrescription,
};
