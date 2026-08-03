/**
 * One-time idempotent migration script.
 * Sets accountIndex, lastActiveAt, and accountLabel on all PatientUser docs
 * that don't already have accountIndex defined.
 *
 * Usage:
 *   node scripts/migrate-account-index.js
 *
 * Requires MONGO_URI in a .env file at the backend root (or as an env var).
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("❌  MONGO_URI is not defined. Set it in .env or as an env variable.");
  process.exit(1);
}

(async () => {
  try {
    console.log("⏳  Connecting to MongoDB …");
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    console.log("✅  Connected to MongoDB.");

    const collection = mongoose.connection.db.collection("patientusers");

    // Idempotent: only update docs where accountIndex is not yet set
    const filter = { accountIndex: { $exists: false } };

    const countBefore = await collection.countDocuments(filter);
    console.log(`📊  Documents without accountIndex: ${countBefore}`);

    if (countBefore === 0) {
      console.log("✅  Nothing to migrate — all documents already have accountIndex.");
    } else {
      const result = await collection.updateMany(filter, {
        $set: {
          accountIndex: 0,
          lastActiveAt: new Date(),
          accountLabel: "Self",
        },
      });

      console.log(`✅  Migration complete.  Matched: ${result.matchedCount}  Modified: ${result.modifiedCount}`);
    }
  } catch (err) {
    console.error("❌  Migration failed:", err.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log("🔌  Disconnected from MongoDB.");
  }
})();
