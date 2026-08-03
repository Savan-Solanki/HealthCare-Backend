const nodemailer = require("nodemailer");
const AppError = require("./AppError");
const logger = require("./logger");

const isEmailConfigured = () => {
  const requiredKeys = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS"];
  return requiredKeys.every((key) => Boolean(process.env[key]));
};

const sendEmail = async (options) => {
  const requiredKeys = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS"];
  const missingKeys = requiredKeys.filter((key) => !process.env[key]);

  if (missingKeys.length > 0) {
    throw new AppError(
      `Email service is not configured. Set ${missingKeys.join(", ")} in Render environment variables.`,
      503
    );
  }

  const port = Number(process.env.SMTP_PORT);

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const mailOptions = {
    from: `Medkwik HMS <${process.env.SMTP_USER}>`,
    to: options.email,
    subject: options.subject,
    text: options.message,
    html: options.html,
  };

  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logger.error(`SMTP send failed for ${options.email}: ${error.message}`);
    throw new AppError(
      "Unable to send email right now. Verify SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS on the server.",
      502
    );
  }
};

module.exports = sendEmail;
module.exports.isEmailConfigured = isEmailConfigured;
