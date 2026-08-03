require("dotenv").config({ path: "a:/MedkwikHealthbuddy/backend/.env" });
const mongoose = require("mongoose");
const connectDB = require("a:/MedkwikHealthbuddy/backend/config/db");
const Hospital = require("a:/MedkwikHealthbuddy/backend/models/Hospital");
const User = require("a:/MedkwikHealthbuddy/backend/models/User");
const Staff = require("a:/MedkwikHealthbuddy/backend/models/Staff");
const Doctor = require("a:/MedkwikHealthbuddy/backend/models/Doctor");
const Activity = require("a:/MedkwikHealthbuddy/backend/models/Activity");
const NotificationLog = require("a:/MedkwikHealthbuddy/backend/models/NotificationLog");
const AppointmentNotification = require("a:/MedkwikHealthbuddy/backend/models/AppointmentNotification");
const HospitalAuditLog = require("a:/MedkwikHealthbuddy/backend/models/HospitalAuditLog");
const { verifyHospitalStaffLimits } = require("a:/MedkwikHealthbuddy/backend/utils/hospitalAccess");

const runVerification = async () => {
  console.log("Connecting to Database...");
  await connectDB();

  let testHospital;
  try {
    console.log("1. Creating test hospital...");
    testHospital = await Hospital.create({
      name: "Verification Test Hospital " + Date.now(),
      city: "Test City",
      beds: 10,
      maxDoctors: 2,
      maxReceptionists: 1,
      maxNurses: 1,
      maxStaff: 1,
      subscriptionType: "demo",
      demoStartDate: new Date(),
      demoExpiryDate: new Date(Date.now() - 3600000), // expired 1 hour ago
      subscriptionStatus: "active",
      status: "Active",
    });
    console.log("Test Hospital created successfully:", testHospital.name);

    // Create dummy logs (8 days ago vs 1 hour ago)
    console.log("\n2. Testing 7-day log cleanup automation...");
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const oneHourAgo = new Date(Date.now() - 3600000);

    const oldActivity = await Activity.create({
      action: "TEST_OLD",
      entity: "System",
      description: "Test old activity log",
      createdAt: eightDaysAgo,
    });
    const newActivity = await Activity.create({
      action: "TEST_NEW",
      entity: "System",
      description: "Test new activity log",
      createdAt: oneHourAgo,
    });

    const oldNotif = await NotificationLog.create({
      patientUserId: new mongoose.Types.ObjectId(),
      status: "sent",
      title: "Test Old Notification",
      body: "Test body",
      category: "system",
      createdAt: eightDaysAgo,
    });
    const newNotif = await NotificationLog.create({
      patientUserId: new mongoose.Types.ObjectId(),
      status: "sent",
      title: "Test New Notification",
      body: "Test body",
      category: "system",
      createdAt: oneHourAgo,
    });

    // Test scheduled tasks
    console.log("Running scheduled tasks...");
    const { runScheduledTasks } = require("a:/MedkwikHealthbuddy/backend/jobs/scheduledTasks");
    await runScheduledTasks();

    // Verify cleanup
    const verifyOldAct = await Activity.findById(oldActivity._id);
    const verifyNewAct = await Activity.findById(newActivity._id);
    const verifyOldNotif = await NotificationLog.findById(oldNotif._id);
    const verifyNewNotif = await NotificationLog.findById(newNotif._id);

    if (!verifyOldAct && verifyNewAct) {
      console.log("PASS: 8-day old activity log was deleted, and 1-hour old activity log was preserved.");
    } else {
      console.error("FAIL: Activity log cleanup failed. Old:", verifyOldAct, "New:", verifyNewAct);
    }

    if (!verifyOldNotif && verifyNewNotif) {
      console.log("PASS: 8-day old notification log was deleted, and 1-hour old notification log was preserved.");
    } else {
      console.error("FAIL: Notification log cleanup failed. Old:", verifyOldNotif, "New:", verifyNewNotif);
    }

    // Clean up test new logs
    await Activity.deleteOne({ _id: newActivity._id });
    await NotificationLog.deleteOne({ _id: newNotif._id });

  } catch (err) {
    console.error("Error during verification:", err);
  } finally {
    if (testHospital) {
      console.log("\nCleaning up test data...");
      await Hospital.deleteOne({ _id: testHospital._id });
      console.log("Cleanup done.");
    }
    await mongoose.connection.close();
    console.log("Database connection closed.");
  }
};

runVerification();
