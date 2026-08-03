const logger = require("../utils/logger");

const parseBoolean = (value) => String(value).toLowerCase() === "true";

const validateEnv = () => {
  const environment = process.env.NODE_ENV || "development";
  const required = ["MONGO_URI", "JWT_SECRET", "JWT_REFRESH_SECRET", "CLIENT_URL"];
  const requiredInProduction = [
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASS",
    "TURNSTILE_SECRET_KEY",
    "AWS_REGION",
    "AWS_S3_BUCKET",
  ];

  const missing = required.filter((key) => !process.env[key]);
  const missingInProduction =
    environment === "production"
      ? requiredInProduction.filter((key) => !process.env[key])
      : [];

  if (missing.length > 0 || missingInProduction.length > 0) {
    const keys = [...missing, ...missingInProduction];
    throw new Error(`Missing required environment variables: ${keys.join(", ")}`);
  }

  if (!process.env.ADMIN_EMAIL && parseBoolean(process.env.ENABLE_DEFAULT_ADMIN_SEED)) {
    logger.warn("ENABLE_DEFAULT_ADMIN_SEED is enabled without ADMIN_EMAIL. Falling back to the default admin email for non-production only.");
  }

  if (environment !== "production") {
    const optionalWarnings = requiredInProduction.filter((key) => !process.env[key]);
    if (optionalWarnings.length > 0) {
      logger.warn(
        `Optional development environment variables are missing: ${optionalWarnings.join(", ")}`
      );
    }
  }
};

module.exports = validateEnv;
