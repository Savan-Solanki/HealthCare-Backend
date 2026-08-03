const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");

// Load environments
dotenv.config({ path: path.join(__dirname, "../.env") });

const Appointment = require("../models/Appointment");
const Prescription = require("../models/Prescription");
const MedicineReminder = require("../models/MedicineReminder");

async function migrate() {
  const dbUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/medkwik";
  console.log("Connecting to Database:", dbUri);
  await mongoose.connect(dbUri);
  console.log("Connected to Database successfully.");

  try {
    // 1. Appointments
    console.log("Migrating Appointments...");
    const appts = await Appointment.find({ updatedAt: { $exists: false } });
    console.log(`Found ${appts.length} appointments without updatedAt.`);
    for (const doc of appts) {
      doc.updatedAt = doc.createdAt || new Date();
      await doc.save({ validateBeforeSave: false });
    }
    console.log("Appointments migrated.");

    // 2. Prescriptions
    console.log("Migrating Prescriptions...");
    const prescriptions = await Prescription.find({ updatedAt: { $exists: false } });
    console.log(`Found ${prescriptions.length} prescriptions without updatedAt.`);
    for (const doc of prescriptions) {
      doc.updatedAt = doc.createdAt || new Date();
      await doc.save({ validateBeforeSave: false });
    }
    console.log("Prescriptions migrated.");

    // 3. MedicineReminders
    console.log("Migrating MedicineReminders...");
    const reminders = await MedicineReminder.find({ updatedAt: { $exists: false } });
    console.log(`Found ${reminders.length} reminders without updatedAt.`);
    for (const doc of reminders) {
      doc.updatedAt = doc.createdAt || new Date();
      await doc.save({ validateBeforeSave: false });
    }
    console.log("MedicineReminders migrated.");

    console.log("Migration completed successfully.");
  } catch (error) {
    console.error("Migration failed:", error);
  } finally {
    await mongoose.disconnect();
  }
}

migrate();
