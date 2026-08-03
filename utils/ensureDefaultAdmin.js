const User = require("../models/User");
const logger = require("./logger");

const ensureDefaultAdmin = async () => {
  const environment = process.env.NODE_ENV || "development";
  const shouldSeedDefaultAdmin =
    process.env.ENABLE_DEFAULT_ADMIN_SEED === "true" || environment !== "production";

  if (!shouldSeedDefaultAdmin) {
    logger.info("Default Super Admin seed skipped.");
    return null;
  }

  const adminEmail = (process.env.ADMIN_EMAIL || "superadmin@medkwik.com").trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD;
  const adminName = process.env.ADMIN_NAME || "Super Administrator";

  if (environment === "production" && !adminPassword) {
    throw new Error(
      "ADMIN_PASSWORD must be configured when ENABLE_DEFAULT_ADMIN_SEED is enabled in production."
    );
  }

  if (!adminPassword) {
    logger.warn(
      "ADMIN_PASSWORD is not configured. Skipping default Super Admin creation in this environment."
    );
    return null;
  }

  const existingAdmin = await User.findOne({ email: adminEmail });
  if (existingAdmin) {
    return existingAdmin;
  }

  const adminUser = await User.create({
    name: adminName,
    email: adminEmail,
    password: adminPassword,
    role: "Super Admin",
    status: "Active",
    isEmailVerified: true,
  });

  logger.info(`Default Super Admin ensured: ${adminUser.email}`);
  return adminUser;
};

module.exports = ensureDefaultAdmin;
