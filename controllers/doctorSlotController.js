const DoctorAvailability = require("../models/DoctorAvailability");
const DoctorSlot = require("../models/DoctorSlot");
const DoctorLeave = require("../models/DoctorLeave");
const Doctor = require("../models/Doctor");
const Appointment = require("../models/Appointment");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { emitSlotsUpdated } = require("../utils/realtimeEvents");
const logger = require("../utils/logger");

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Parse "HH:mm" into total minutes from midnight.
 */
const timeToMinutes = (timeStr) => {
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
};

/**
 * Convert total minutes from midnight to "HH:mm" string.
 */
const minutesToTime = (totalMinutes) => {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

// Helper to resolve hospital ID
const resolveHospitalId = (value) => {
  if (!value) return null;
  if (typeof value === "object" && value._id) return value._id;
  return value;
};

const getScopedHospitalId = (req) => {
  const role = req.user.role;
  const assignedHospitalId = resolveHospitalId(req.user.hospitalId);

  if (role === "Hospital Admin" || role === "Receptionist" || role === "Doctor") {
    if (!assignedHospitalId) {
      throw new AppError(`${role} is not assigned to a hospital.`, 403);
    }
    return assignedHospitalId;
  }

  if (role === "Super Admin") {
    const requestedHospitalId = req.query.hospitalId || req.body.hospitalId;
    if (!requestedHospitalId) {
      throw new AppError("Hospital id is required.", 400);
    }
    return requestedHospitalId;
  }

  throw new AppError("You do not have permission to access this hospital resource.", 403);
};

// Helper to resolve doctor ID and hospital ID from request/token
const resolveDoctorContext = async (req) => {
  const hospitalId = getScopedHospitalId(req);
  if (req.user.role === "Doctor") {
    const doctor = await Doctor.findOne({
      $or: [{ userId: req.user._id }, { email: req.user.email }],
      hospitalId,
    });
    if (!doctor) {
      throw new AppError("Doctor profile not found for this user.", 404);
    }
    return { hospitalId, doctorId: doctor._id, isDoctor: true };
  }

  const doctorId = req.body.doctorId || req.query.doctorId || req.params.doctorId;
  if (!doctorId) {
    throw new AppError("Doctor ID is required.", 400);
  }
  return { hospitalId, doctorId, isDoctor: false };
};


// ─── WEEKLY AVAILABILITY RANGES ─────────────────────────────────────────────

exports.getWeeklyAvailability = catchAsync(async (req, res, next) => {
  const { hospitalId, doctorId } = await resolveDoctorContext(req);

  const availabilities = await DoctorAvailability.find({ hospitalId, doctorId }).sort({ dayOfWeek: 1 });

  res.status(200).json({
    success: true,
    data: availabilities,
  });
});

exports.updateWeeklyAvailability = catchAsync(async (req, res, next) => {
  const { hospitalId, doctorId } = await resolveDoctorContext(req);
  const { availabilities } = req.body; // Array: [{ dayOfWeek, startTime, endTime, isActive }]

  if (!Array.isArray(availabilities)) {
    return next(new AppError("Availabilities must be an array.", 400));
  }

  // Validate format
  for (const item of availabilities) {
    if (item.dayOfWeek < 0 || item.dayOfWeek > 6) {
      return next(new AppError("dayOfWeek must be between 0 and 6.", 400));
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(item.startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.endTime)) {
      return next(new AppError("startTime and endTime must be in HH:mm 24-hour format.", 400));
    }
  }

  // Delete existing weekly availabilities for this doctor
  await DoctorAvailability.deleteMany({ hospitalId, doctorId });

  // Insert new ones
  const newAvailabilities = await DoctorAvailability.insertMany(
    availabilities.map((item) => ({
      hospitalId,
      doctorId,
      dayOfWeek: item.dayOfWeek,
      startTime: item.startTime,
      endTime: item.endTime,
      isActive: item.isActive !== undefined ? item.isActive : true,
    }))
  );

  res.status(200).json({
    success: true,
    message: "Weekly availability updated successfully.",
    data: newAvailabilities,
  });
});

// ─── MANUAL SLOT MANAGEMENT ───────────────────────────────────────────────

exports.createSlots = catchAsync(async (req, res, next) => {
  const { hospitalId, doctorId } = await resolveDoctorContext(req);
  const { date, slotTimes } = req.body; // date: YYYY-MM-DD, slotTimes: ["10:00", "10:30"]

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return next(new AppError("Valid date (YYYY-MM-DD) is required.", 400));
  }
  if (!Array.isArray(slotTimes) || slotTimes.length === 0) {
    return next(new AppError("slotTimes must be a non-empty array.", 400));
  }

  // Clean and validate slotTimes
  const formattedSlotTimes = slotTimes.map((time) => {
    // If time is in 12-hour format (e.g. "10:00 AM"), convert to 24-hour HH:mm
    if (/^[01]?\d:[0-5]\d\s*(?:AM|PM)$/i.test(time)) {
      const [timeStr, modifier] = time.split(/\s+/);
      let [hours, minutes] = timeStr.split(":");
      if (hours === "12") {
        hours = "00";
      }
      if (modifier.toUpperCase() === "PM") {
        hours = String(parseInt(hours, 10) + 12);
      }
      return `${hours.padStart(2, "0")}:${minutes.padStart(2, "0")}`;
    }
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      return time;
    }
    throw new AppError(`Invalid time format: ${time}. Use HH:mm or HH:mm AM/PM.`, 400);
  });

  const createdSlots = [];
  for (const slotTime of formattedSlotTimes) {
    const existing = await DoctorSlot.findOne({ hospitalId, doctorId, date, slotTime });
    if (!existing) {
      const slot = await DoctorSlot.create({
        hospitalId,
        doctorId,
        date,
        slotTime,
        status: "Available",
        isActive: true,
      });
      createdSlots.push(slot);
    } else if (existing.status !== "Booked") {
      existing.status = "Available";
      existing.isActive = true;
      await existing.save();
      createdSlots.push(existing);
    } else {
      createdSlots.push(existing); // keep booked slot unchanged
    }
  }

  emitSlotsUpdated(hospitalId, doctorId, date);

  res.status(201).json({
    success: true,
    message: "Slots configured successfully.",
    data: createdSlots,
  });
});

exports.getSlots = catchAsync(async (req, res, next) => {
  const { hospitalId, doctorId } = await resolveDoctorContext(req);
  const { date } = req.query; // YYYY-MM-DD

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return next(new AppError("Valid date (YYYY-MM-DD) is required.", 400));
  }

  // Fetch slots
  const slots = await DoctorSlot.find({ hospitalId, doctorId, date }).sort({ slotTime: 1 });

  // Check if doctor has an active leave on this date
  const leave = await DoctorLeave.findOne({
    hospitalId,
    doctorId,
    startDate: { $lte: date },
    endDate: { $gte: date },
    status: "Active",
  });

  let isOnLeave = false;
  let leaveDetails = null;

  if (leave) {
    isOnLeave = true;
    leaveDetails = {
      leaveType: leave.leaveType,
      reason: leave.reason,
      halfDayOption: leave.halfDayOption,
    };
  }

  // Map slots to overlay leave status dynamically
  const mappedSlots = slots.map((slot) => {
    let status = slot.status;
    if (isOnLeave) {
      // If it is a Half-Day Leave, check if slot falls in the leave period
      if (leave.leaveType === "Half-Day Leave") {
        const slotHour = parseInt(slot.slotTime.split(":")[0], 10);
        if (leave.halfDayOption === "First Half" && slotHour < 14) {
          status = "Doctor On Leave";
        } else if (leave.halfDayOption === "Second Half" && slotHour >= 14) {
          status = "Doctor On Leave";
        }
      } else {
        // Full day or emergency leaves affect all slots
        status = "Doctor On Leave";
      }
    }
    return {
      ...slot.toObject(),
      status,
    };
  });

  res.status(200).json({
    success: true,
    data: {
      isOnLeave,
      leaveDetails,
      slots: mappedSlots,
    },
  });
});

exports.updateSlotStatus = catchAsync(async (req, res, next) => {
  const { hospitalId } = await resolveDoctorContext(req);
  const { status, isActive, slotTime } = req.body;

  const slot = await DoctorSlot.findOne({ _id: req.params.id, hospitalId });
  if (!slot) {
    return next(new AppError("Slot not found.", 404));
  }

  if (slot.status === "Booked" && (status && status !== "Booked" || slotTime !== undefined)) {
    return next(new AppError("Cannot change status or time of a booked slot directly. Reschedule or cancel the appointment instead.", 400));
  }

  if (slotTime !== undefined && slotTime !== slot.slotTime) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(slotTime)) {
      return next(new AppError("slotTime must be in HH:mm 24-hour format.", 400));
    }
    // Check duplication
    const duplicate = await DoctorSlot.findOne({
      hospitalId,
      doctorId: slot.doctorId,
      date: slot.date,
      slotTime,
    });
    if (duplicate) {
      return next(new AppError("A slot with this time already exists on this date.", 400));
    }
    slot.slotTime = slotTime;
  }

  if (status !== undefined) slot.status = status;
  if (isActive !== undefined) slot.isActive = isActive;

  await slot.save();
  emitSlotsUpdated(hospitalId, slot.doctorId, slot.date);

  res.status(200).json({
    success: true,
    message: "Slot updated successfully.",
    data: slot,
  });
});

exports.deleteSlot = catchAsync(async (req, res, next) => {
  const { hospitalId } = await resolveDoctorContext(req);

  const slot = await DoctorSlot.findOne({ _id: req.params.id, hospitalId });
  if (!slot) {
    return next(new AppError("Slot not found.", 404));
  }

  if (slot.status === "Booked") {
    return next(new AppError("Cannot delete a booked slot. Cancel the appointment first.", 400));
  }

  await DoctorSlot.deleteOne({ _id: slot._id });
  emitSlotsUpdated(hospitalId, slot.doctorId, slot.date);

  res.status(200).json({
    success: true,
    message: "Slot deleted successfully.",
  });
});

// ─── LEAVE MANAGEMENT ──────────────────────────────────────────────────────

exports.markLeave = catchAsync(async (req, res, next) => {
  const { hospitalId, doctorId } = await resolveDoctorContext(req);
  const { leaveType, startDate, endDate, halfDayOption, reason } = req.body;

  if (!leaveType || !startDate || !endDate) {
    return next(new AppError("leaveType, startDate, and endDate are required.", 400));
  }

  const leave = await DoctorLeave.create({
    hospitalId,
    doctorId,
    leaveType,
    startDate,
    endDate,
    halfDayOption: leaveType === "Half-Day Leave" ? halfDayOption : null,
    reason,
    status: "Active",
  });

  // Dynamically update existing slots covering this leave window to "Doctor On Leave"
  // For Half-Day leaves, we update only slots falling into the half-day period
  const slots = await DoctorSlot.find({
    hospitalId,
    doctorId,
    date: { $gte: startDate, $lte: endDate },
    status: { $ne: "Booked" },
  });

  for (const slot of slots) {
    if (leaveType === "Half-Day Leave") {
      const slotHour = parseInt(slot.slotTime.split(":")[0], 10);
      if (halfDayOption === "First Half" && slotHour < 14) {
        slot.status = "Doctor On Leave";
        await slot.save();
      } else if (halfDayOption === "Second Half" && slotHour >= 14) {
        slot.status = "Doctor On Leave";
        await slot.save();
      }
    } else {
      slot.status = "Doctor On Leave";
      await slot.save();
    }
  }

  // Trigger real-time sync for each date in range
  const start = new Date(startDate);
  const end = new Date(endDate);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split("T")[0];
    emitSlotsUpdated(hospitalId, doctorId, dateStr);
  }

  res.status(201).json({
    success: true,
    message: "Doctor leave marked successfully.",
    data: leave,
  });
});

exports.getLeaves = catchAsync(async (req, res, next) => {
  const { hospitalId, doctorId } = await resolveDoctorContext(req);

  const leaves = await DoctorLeave.find({ hospitalId, doctorId, status: "Active" }).sort({ startDate: -1 });

  res.status(200).json({
    success: true,
    data: leaves,
  });
});

exports.cancelLeave = catchAsync(async (req, res, next) => {
  const { hospitalId } = await resolveDoctorContext(req);

  const leave = await DoctorLeave.findOne({ _id: req.params.id, hospitalId });
  if (!leave) {
    return next(new AppError("Leave record not found.", 404));
  }

  leave.status = "Cancelled";
  await leave.save();

  // Revert slots that were marked "Doctor On Leave" back to "Available"
  const slots = await DoctorSlot.find({
    hospitalId,
    doctorId: leave.doctorId,
    date: { $gte: leave.startDate, $lte: leave.endDate },
    status: "Doctor On Leave",
  });

  for (const slot of slots) {
    slot.status = "Available";
    await slot.save();
  }

  // Trigger real-time updates
  const start = new Date(leave.startDate);
  const end = new Date(leave.endDate);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split("T")[0];
    emitSlotsUpdated(hospitalId, leave.doctorId, dateStr);
  }

  res.status(200).json({
    success: true,
    message: "Leave cancelled successfully.",
    data: leave,
  });
});

// ─── GENERATE SLOTS FROM WEEKLY AVAILABILITY ────────────────────────────────

exports.generateSlotsFromAvailability = catchAsync(async (req, res, next) => {
  const { hospitalId, doctorId } = await resolveDoctorContext(req);
  const { date, intervalMinutes } = req.body;

  // Validate date
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return next(new AppError("Valid date (YYYY-MM-DD) is required.", 400));
  }

  // Validate interval
  const validIntervals = [15, 30, 45, 60];
  const interval = parseInt(intervalMinutes, 10);
  if (!validIntervals.includes(interval)) {
    return next(new AppError("intervalMinutes must be one of: 15, 30, 45, 60.", 400));
  }

  // Determine the day of week (0=Sunday, 1=Monday, ... 6=Saturday)
  const [year, month, day] = date.split("-").map(Number);
  const targetDate = new Date(year, month - 1, day);
  const dayOfWeek = targetDate.getDay();

  // Look up the availability record for this doctor on this weekday
  const availability = await DoctorAvailability.findOne({
    hospitalId,
    doctorId,
    dayOfWeek,
    isActive: true,
  });

  if (!availability) {
    return next(
      new AppError(
        `No active weekly availability found for this doctor on ${["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][dayOfWeek]}. Please configure weekly hours first.`,
        404
      )
    );
  }

  const startMinutes = timeToMinutes(availability.startTime);
  const endMinutes = timeToMinutes(availability.endTime);

  if (startMinutes >= endMinutes) {
    return next(new AppError("Weekly availability start time must be before end time.", 400));
  }

  // Generate all slot times at the given interval
  const generatedTimes = [];
  for (let t = startMinutes; t < endMinutes; t += interval) {
    generatedTimes.push(minutesToTime(t));
  }

  if (generatedTimes.length === 0) {
    return next(new AppError("No slots could be generated for the given time range and interval.", 400));
  }

  // Upsert each slot (create if not exists, re-activate if deactivated, skip booked)
  const results = { created: 0, reactivated: 0, skipped: 0 };
  const createdSlots = [];

  for (const slotTime of generatedTimes) {
    const existing = await DoctorSlot.findOne({ hospitalId, doctorId, date, slotTime });
    if (!existing) {
      const slot = await DoctorSlot.create({
        hospitalId,
        doctorId,
        date,
        slotTime,
        status: "Available",
        isActive: true,
      });
      createdSlots.push(slot);
      results.created++;
    } else if (existing.status === "Booked") {
      // Never overwrite a booked slot
      results.skipped++;
      createdSlots.push(existing);
    } else {
      // Re-activate a previously blocked or deactivated slot
      if (!existing.isActive || existing.status !== "Available") {
        existing.status = "Available";
        existing.isActive = true;
        await existing.save();
        results.reactivated++;
      } else {
        results.skipped++;
      }
      createdSlots.push(existing);
    }
  }

  emitSlotsUpdated(hospitalId, doctorId, date);

  logger.info(
    `Generated ${results.created} new + ${results.reactivated} reactivated slots for doctor ${doctorId} on ${date} at ${interval}-min intervals.`
  );

  res.status(201).json({
    success: true,
    message: `Slots generated successfully for ${date} (${interval} min intervals).`,
    summary: {
      totalGenerated: generatedTimes.length,
      created: results.created,
      reactivated: results.reactivated,
      skipped: results.skipped,
      timeRange: `${availability.startTime} – ${availability.endTime}`,
    },
    data: createdSlots,
  });
});
