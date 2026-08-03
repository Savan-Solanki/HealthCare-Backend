require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const PatientUser = require("../models/PatientUser");
const { bulkAdjustPatientCredits } = require("../controllers/userController");

async function run() {
  await connectDB();

  // Find a patient
  const patient = await PatientUser.findOne();
  if (!patient) {
    console.error("No patients found in DB!");
    process.exit(1);
  }

  console.log(`Found test patient: ${patient.name} (${patient._id}) with reportCredits: ${patient.reportCredits}`);

  // Mock req, res, next
  const req = {
    body: {
      userIds: [patient._id.toString()],
      creditType: "report",
      action: "add",
      amount: 5,
      reason: "Bulk adjust test script"
    },
    user: { _id: new mongoose.Types.ObjectId() },
    ip: "127.0.0.1"
  };

  const res = {
    status(code) {
      console.log(`Response status code: ${code}`);
      return this;
    },
    json(data) {
      console.log("Response JSON data:", JSON.stringify(data, null, 2));
      return this;
    }
  };

  const next = (err) => {
    if (err) {
      console.error("Next called with error:", err);
    }
  };

  console.log("Running bulkAdjustPatientCredits...");
  try {
    // Wait for catchAsync promise
    await bulkAdjustPatientCredits(req, res, next);
  } catch (err) {
    console.error("Handler threw uncaught exception:", err);
  }

  // Delay closing the DB connection slightly to allow any trailing operations
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await mongoose.connection.close();
  console.log("DB connection closed.");
}

run().catch(console.error);
