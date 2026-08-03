require("dotenv").config({ path: "a:/MedkwikHealthbuddy/backend/.env" });
const mongoose = require("mongoose");
const connectDB = require("a:/MedkwikHealthbuddy/backend/config/db");
const Hospital = require("a:/MedkwikHealthbuddy/backend/models/Hospital");
const User = require("a:/MedkwikHealthbuddy/backend/models/User");
const Doctor = require("a:/MedkwikHealthbuddy/backend/models/Doctor");

const debugHospitals = async () => {
  await connectDB();
  try {
    const hospitals = await Hospital.find({ isArchived: { $ne: true } }).lean();
    console.log(`Found ${hospitals.length} active hospitals:`);
    for (const h of hospitals) {
      const docCount = await Doctor.countDocuments({ hospitalId: h._id });
      const userDocCount = await User.countDocuments({ hospitalId: h._id, role: "Doctor" });
      console.log(`Hospital: ${h.name} (${h._id})
  - maxDoctors: ${h.maxDoctors}
  - doctors field value: ${h.doctors}
  - Doctor collection count: ${docCount}
  - User (role=Doctor) count: ${userDocCount}
  - maxReceptionists: ${h.maxReceptionists}
  - maxNurses: ${h.maxNurses}
  - maxStaff: ${h.maxStaff}
`);
    }
  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.connection.close();
  }
};

debugHospitals();
