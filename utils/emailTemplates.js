const escapeHtml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const roleThemes = {
  "Super Admin": {
    accent: "#1d4ed8",
    accentSoft: "#dbeafe",
    accentDeep: "#0f172a",
    badge: "SUPER ADMIN",
    roleLabel: "Control Center Access",
    greeting: "Use this verification code to continue into the Medkwik Control Center.",
  },
  "Hospital Admin": {
    accent: "#0f766e",
    accentSoft: "#ccfbf1",
    accentDeep: "#134e4a",
    badge: "HOSPITAL ADMIN",
    roleLabel: "Hospital Workspace Access",
    greeting: "Use this verification code to continue into your hospital admin workspace.",
  },
  Doctor: {
    accent: "#15803d",
    accentSoft: "#dcfce7",
    accentDeep: "#14532d",
    badge: "DOCTOR",
    roleLabel: "Doctor Access",
    greeting: "Use this verification code to continue into your clinical workspace.",
  },
  Nurse: {
    accent: "#7c3aed",
    accentSoft: "#ede9fe",
    accentDeep: "#4c1d95",
    badge: "NURSE",
    roleLabel: "Nursing Access",
    greeting: "Use this verification code to continue into your nursing workspace.",
  },
  Receptionist: {
    accent: "#c2410c",
    accentSoft: "#ffedd5",
    accentDeep: "#7c2d12",
    badge: "RECEPTIONIST",
    roleLabel: "Front Desk Access",
    greeting: "Use this verification code to continue into your reception workspace.",
  },
  Staff: {
    accent: "#334155",
    accentSoft: "#e2e8f0",
    accentDeep: "#0f172a",
    badge: "STAFF",
    roleLabel: "Staff Access",
    greeting: "Use this verification code to continue into your staff workspace.",
  },
  Patient: {
    accent: "#0f766e",
    accentSoft: "#ccfbf1",
    accentDeep: "#134e4a",
    badge: "PATIENT",
    roleLabel: "Patient Account",
    greeting: "Use this verification code to continue setting up your Medkwik patient account.",
  },
};

const getRoleTheme = (role) => roleThemes[role] || roleThemes.Staff;

const buildDetailRows = ({ roleLabel, hospitalName, purpose }) => {
  const details = [
    { label: "Access", value: roleLabel },
    {
      label: "Purpose",
      value:
        purpose === "password-reset"
          ? "Password Reset"
          : purpose === "account-setup"
            ? "Account Setup"
            : "Login Verification",
    },
  ];

  if (hospitalName) {
    details.push({ label: "Hospital", value: hospitalName });
  }

  return details
    .map(
      ({ label, value }) => `
        <tr>
          <td style="padding: 10px 0; font-size: 13px; color: #64748b;">${escapeHtml(label)}</td>
          <td style="padding: 10px 0; font-size: 13px; font-weight: 600; color: #0f172a; text-align: right;">${escapeHtml(value)}</td>
        </tr>
      `
    )
    .join("");
};

const buildAuthEmailTemplate = ({
  userName,
  userRole,
  hospitalName,
  otp,
  purpose,
}) => {
  const theme = getRoleTheme(userRole);
  const isPasswordReset = purpose === "password-reset";
  const isAccountSetup = purpose === "account-setup";
  const title = isPasswordReset
    ? `Reset Your ${userRole} Password`
    : isAccountSetup
      ? `Complete Your ${userRole} Account Setup`
      : `Your ${userRole} Verification Code`;
  const intro = isPasswordReset
    ? "Use the code below to reset your Medkwik HMS password securely."
    : isAccountSetup
      ? "Use the code below to verify your email and finish setting up your Medkwik account."
      : theme.greeting;
  const supportCopy = isPasswordReset
    ? "If you did not request a password reset, contact your super admin immediately."
    : isAccountSetup
      ? "If you did not request this account setup, you can safely ignore this email."
      : "If you did not request this sign-in code, contact your administrator immediately.";

  const subject = isPasswordReset
    ? `Medkwik HMS - ${userRole} Password Reset OTP`
    : isAccountSetup
      ? `Medkwik HMS - ${userRole} Account Setup OTP`
      : `Medkwik HMS - ${userRole} Login OTP`;

  const message = [
    `${title}`,
    `Hello ${userName},`,
    intro,
    `OTP: ${otp}`,
    `This code is valid for 2 minutes.`,
    hospitalName ? `Hospital: ${hospitalName}` : null,
    supportCopy,
  ]
    .filter(Boolean)
    .join("\n");

  const html = `
    <div style="margin: 0; padding: 24px; background: #f8fafc; font-family: Arial, Helvetica, sans-serif; color: #0f172a;">
      <div style="max-width: 640px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 24px; overflow: hidden;">
        <div style="background: linear-gradient(135deg, ${theme.accent} 0%, ${theme.accentDeep} 100%); padding: 30px 32px; color: #ffffff;">
          <div style="display: inline-block; padding: 7px 12px; border-radius: 999px; background: rgba(255,255,255,0.16); font-size: 11px; font-weight: 700; letter-spacing: 0.12em;">
            ${escapeHtml(theme.badge)}
          </div>
          <h1 style="margin: 18px 0 8px; font-size: 28px; line-height: 1.2; font-weight: 700;">
            ${escapeHtml(title)}
          </h1>
          <p style="margin: 0; font-size: 14px; line-height: 1.7; color: rgba(255,255,255,0.92);">
            ${escapeHtml(intro)}
          </p>
        </div>

        <div style="padding: 32px;">
          <p style="margin: 0 0 18px; font-size: 15px; line-height: 1.7; color: #334155;">
            Hello <strong>${escapeHtml(userName)}</strong>,
          </p>

          <div style="border: 1px solid ${theme.accentSoft}; background: #ffffff; border-radius: 20px; padding: 22px; text-align: center; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.4);">
            <p style="margin: 0 0 10px; font-size: 12px; font-weight: 700; letter-spacing: 0.16em; color: ${theme.accent}; text-transform: uppercase;">
              One-Time Password
            </p>
            <div style="display: inline-block; padding: 14px 22px; border-radius: 16px; background: ${theme.accentSoft}; color: ${theme.accentDeep}; font-size: 34px; font-weight: 700; letter-spacing: 0.3em;">
              ${escapeHtml(otp)}
            </div>
            <p style="margin: 14px 0 0; font-size: 13px; color: #64748b;">
              Valid for 2 minutes only
            </p>
          </div>

          <div style="margin-top: 24px; padding: 20px 22px; border-radius: 18px; background: #f8fafc; border: 1px solid #e2e8f0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
              ${buildDetailRows({
                roleLabel: theme.roleLabel,
                hospitalName,
                purpose,
              })}
            </table>
          </div>

          <div style="margin-top: 24px; padding: 18px 20px; border-left: 4px solid ${theme.accent}; background: #f8fafc; border-radius: 12px;">
            <p style="margin: 0; font-size: 13px; line-height: 1.7; color: #475569;">
              ${escapeHtml(supportCopy)}
            </p>
          </div>
        </div>

        <div style="padding: 18px 32px 26px; border-top: 1px solid #e2e8f0; background: #ffffff;">
          <p style="margin: 0; font-size: 12px; line-height: 1.7; color: #94a3b8;">
            Medkwik HMS secure notification. Please do not share this code with anyone.
          </p>
        </div>
      </div>
    </div>
  `;

  return { subject, message, html };
};

const buildDemoExpiryWarningEmail = ({
  hospitalName,
  hospitalCode,
  adminName,
  adminEmail,
  daysRemaining,
  expiresAt,
}) => {
  const formattedExpiry = new Date(expiresAt).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const subject = `medikwik HMS — Demo expires in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"} (${hospitalName})`;

  const message = [
    `Demo access for ${hospitalName} expires in ${daysRemaining} day(s).`,
    `Hospital code: ${hospitalCode || "N/A"}`,
    `Hospital admin: ${adminName} (${adminEmail})`,
    `Expiry: ${formattedExpiry}`,
    "To continue access, update the hospital to permanent or extend the demo from the medikwik Control Center.",
    "Contact medikwik administrators if you need assistance.",
  ].join("\n");

  const html = `
    <div style="margin:0;padding:24px;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:24px;overflow:hidden;">
        <div style="background:linear-gradient(135deg,#c2410c 0%,#7c2d12 100%);padding:30px 32px;color:#ffffff;">
          <div style="display:inline-block;padding:7px 12px;border-radius:999px;background:rgba(255,255,255,0.16);font-size:11px;font-weight:700;letter-spacing:0.12em;">
            DEMO EXPIRY ALERT
          </div>
          <h1 style="margin:18px 0 8px;font-size:26px;line-height:1.2;font-weight:700;">
            Hospital demo ending soon
          </h1>
          <p style="margin:0;font-size:14px;line-height:1.7;color:rgba(255,255,255,0.92);">
            The demo period for <strong>${escapeHtml(hospitalName)}</strong> ends in
            <strong>${daysRemaining} day${daysRemaining === 1 ? "" : "s"}</strong>.
          </p>
        </div>
        <div style="padding:32px;">
          <div style="border:1px solid #ffedd5;background:#fff7ed;border-radius:18px;padding:20px 22px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
              <tr>
                <td style="padding:8px 0;font-size:13px;color:#64748b;">Hospital</td>
                <td style="padding:8px 0;font-size:13px;font-weight:600;color:#0f172a;text-align:right;">${escapeHtml(hospitalName)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;font-size:13px;color:#64748b;">Hospital code</td>
                <td style="padding:8px 0;font-size:13px;font-weight:600;color:#0f172a;text-align:right;">${escapeHtml(hospitalCode || "N/A")}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;font-size:13px;color:#64748b;">Hospital admin</td>
                <td style="padding:8px 0;font-size:13px;font-weight:600;color:#0f172a;text-align:right;">${escapeHtml(adminName)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;font-size:13px;color:#64748b;">Admin email</td>
                <td style="padding:8px 0;font-size:13px;font-weight:600;color:#0f172a;text-align:right;">${escapeHtml(adminEmail)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;font-size:13px;color:#64748b;">Demo expires</td>
                <td style="padding:8px 0;font-size:13px;font-weight:600;color:#0f172a;text-align:right;">${escapeHtml(formattedExpiry)}</td>
              </tr>
            </table>
          </div>
          <div style="margin-top:24px;padding:18px 20px;border-left:4px solid #c2410c;background:#f8fafc;border-radius:12px;">
            <p style="margin:0;font-size:13px;line-height:1.7;color:#475569;">
              When the demo ends, hospital portal access will be suspended for doctors, receptionists, and hospital admins until a super admin converts the hospital to <strong>permanent</strong> access or extends the demo period.
            </p>
          </div>
          <p style="margin:24px 0 0;font-size:13px;line-height:1.7;color:#64748b;">
            To continue service, open the medikwik Control Center and update this hospital from the System Users or Manage Hospitals section.
          </p>
        </div>
        <div style="padding:18px 32px 26px;border-top:1px solid #e2e8f0;background:#ffffff;">
          <p style="margin:0;font-size:12px;line-height:1.7;color:#94a3b8;">
            medikwik HMS automated notification for super administrators.
          </p>
        </div>
      </div>
    </div>
  `;

  return { subject, message, html };
};

const buildDemoExpiryWarningEmailForHospital = ({
  hospitalName,
  hospitalCode,
  daysRemaining,
  expiresAt,
}) => {
  const formattedExpiry = new Date(expiresAt).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const subject = `⚠️ Your Medkwik demo expires in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"} — Action Required`;

  const message = [
    `Dear ${hospitalName} Team,`,
    `Your demo access to the Medkwik HMS portal expires in ${daysRemaining} day(s).`,
    `Hospital code: ${hospitalCode || "N/A"}`,
    `Expiry date: ${formattedExpiry}`,
    "After the demo period ends, all portal access (hospital admin, doctors, receptionists) will be suspended.",
    "To continue using Medkwik HMS without interruption, please contact Medkwik support to upgrade to a permanent subscription.",
    "Thank you for choosing Medkwik.",
  ].join("\n");

  const html = `
    <div style="margin:0;padding:24px;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:24px;overflow:hidden;">
        <div style="background:linear-gradient(135deg,#d97706 0%,#92400e 100%);padding:30px 32px;color:#ffffff;">
          <div style="display:inline-block;padding:7px 12px;border-radius:999px;background:rgba(255,255,255,0.16);font-size:11px;font-weight:700;letter-spacing:0.12em;">
            DEMO EXPIRY WARNING
          </div>
          <h1 style="margin:18px 0 8px;font-size:26px;line-height:1.2;font-weight:700;">
            Your demo is ending soon
          </h1>
          <p style="margin:0;font-size:14px;line-height:1.7;color:rgba(255,255,255,0.92);">
            <strong>${escapeHtml(hospitalName)}</strong> — only
            <strong>${daysRemaining} day${daysRemaining === 1 ? "" : "s"}</strong> remaining.
          </p>
        </div>
        <div style="padding:32px;">
          <p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#334155;">
            Dear <strong>${escapeHtml(hospitalName)}</strong> Team,
          </p>
          <p style="margin:0 0 18px;font-size:14px;line-height:1.7;color:#475569;">
            Your demo access to the Medkwik Hospital Management System is set to expire on
            <strong>${escapeHtml(formattedExpiry)}</strong>. After this date, all portal access — including
            hospital admin, doctors, and receptionists — will be <strong>automatically suspended</strong>.
          </p>
          <div style="border:1px solid #fef3c7;background:#fffbeb;border-radius:18px;padding:20px 22px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
              <tr>
                <td style="padding:8px 0;font-size:13px;color:#64748b;">Hospital</td>
                <td style="padding:8px 0;font-size:13px;font-weight:600;color:#0f172a;text-align:right;">${escapeHtml(hospitalName)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;font-size:13px;color:#64748b;">Hospital Code</td>
                <td style="padding:8px 0;font-size:13px;font-weight:600;color:#0f172a;text-align:right;">${escapeHtml(hospitalCode || "N/A")}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;font-size:13px;color:#64748b;">Demo Expires</td>
                <td style="padding:8px 0;font-size:13px;font-weight:600;color:#b45309;text-align:right;">${escapeHtml(formattedExpiry)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;font-size:13px;color:#64748b;">Days Remaining</td>
                <td style="padding:8px 0;font-size:13px;font-weight:600;color:#b45309;text-align:right;">${daysRemaining} day${daysRemaining === 1 ? "" : "s"}</td>
              </tr>
            </table>
          </div>
          <div style="margin-top:24px;padding:18px 20px;border-left:4px solid #d97706;background:#fffbeb;border-radius:12px;">
            <p style="margin:0;font-size:13px;line-height:1.7;color:#92400e;">
              <strong>What to do:</strong> Contact Medkwik support or your assigned administrator to upgrade your hospital to a <strong>permanent subscription</strong> and avoid service interruption.
            </p>
          </div>
          <p style="margin:24px 0 0;font-size:13px;line-height:1.7;color:#64748b;">
            Thank you for choosing Medkwik HMS. We look forward to continuing to serve you.
          </p>
        </div>
        <div style="padding:18px 32px 26px;border-top:1px solid #e2e8f0;background:#ffffff;">
          <p style="margin:0;font-size:12px;line-height:1.7;color:#94a3b8;">
            This is an automated notification from Medkwik HMS. Please do not reply to this email.
          </p>
        </div>
      </div>
    </div>
  `;

  return { subject, message, html };
};

const buildDemoExpiryEmail = ({
  hospitalName,
  hospitalCode,
  type, // "warning-7", "reminder-3", "final-1", "expired-0"
  expiresAt,
}) => {
  const formattedExpiry = new Date(expiresAt).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  let subject = "";
  let title = "";
  let messageText = "";

  if (type === "warning-7") {
    subject = "Demo Expiry Warning";
    title = "Demo Expiry Warning";
    messageText = `Your demo access to the Medkwik HMS portal expires in 7 days. Expiry date: ${formattedExpiry}.`;
  } else if (type === "reminder-3") {
    subject = "Reminder Email";
    title = "Demo Expiry Reminder";
    messageText = `This is a reminder that your demo access to the Medkwik HMS portal expires in 3 days. Expiry date: ${formattedExpiry}.`;
  } else if (type === "final-1") {
    subject = "Final Warning";
    title = "Final Demo Expiry Warning";
    messageText = `This is your final warning. Your demo access to the Medkwik HMS portal expires tomorrow. Expiry date: ${formattedExpiry}.`;
  } else if (type === "expired-0") {
    subject = "Subscription Expired";
    title = "Subscription Expired";
    messageText = "Your demo access to the Medkwik HMS portal has expired. All portal access has been suspended.";
  }

  const message = [
    `Dear ${hospitalName} Team,`,
    messageText,
    `Hospital code: ${hospitalCode || "N/A"}`,
    type !== "expired-0" ? "To continue using Medkwik HMS without interruption, please contact Medkwik support to upgrade to a permanent subscription." : "Please contact Super Admin to reactivate your subscription.",
    "Thank you for choosing Medkwik.",
  ].join("\n");

  const html = `
    <div style="margin:0;padding:24px;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:24px;overflow:hidden;">
        <div style="background:linear-gradient(135deg,${type === 'expired-0' ? '#dc2626, #991b1b' : '#d97706, #92400e'} 0%, 100%);padding:30px 32px;color:#ffffff;">
          <div style="display:inline-block;padding:7px 12px;border-radius:999px;background:rgba(255,255,255,0.16);font-size:11px;font-weight:700;letter-spacing:0.12em;">
            ${title.toUpperCase()}
          </div>
          <h1 style="margin:18px 0 8px;font-size:26px;line-height:1.2;font-weight:700;">
            ${title}
          </h1>
          <p style="margin:0;font-size:14px;line-height:1.7;color:rgba(255,255,255,0.92);">
            <strong>${escapeHtml(hospitalName)}</strong>
          </p>
        </div>
        <div style="padding:32px;">
          <p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#334155;">
            Dear <strong>${escapeHtml(hospitalName)}</strong> Team,
          </p>
          <p style="margin:0 0 18px;font-size:14px;line-height:1.7;color:#475569;">
            ${messageText}
          </p>
          <div style="border:1px solid #e2e8f0;background:#f8fafc;border-radius:18px;padding:20px 22px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
              <tr>
                <td style="padding:8px 0;font-size:13px;color:#64748b;">Hospital</td>
                <td style="padding:8px 0;font-size:13px;font-weight:600;color:#0f172a;text-align:right;">${escapeHtml(hospitalName)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;font-size:13px;color:#64748b;">Hospital Code</td>
                <td style="padding:8px 0;font-size:13px;font-weight:600;color:#0f172a;text-align:right;">${escapeHtml(hospitalCode || "N/A")}</td>
              </tr>
              ${type !== "expired-0" ? `
              <tr>
                <td style="padding:8px 0;font-size:13px;color:#64748b;">Demo Expires</td>
                <td style="padding:8px 0;font-size:13px;font-weight:600;color:#b45309;text-align:right;">${escapeHtml(formattedExpiry)}</td>
              </tr>
              ` : `
              <tr>
                <td style="padding:8px 0;font-size:13px;color:#64748b;">Status</td>
                <td style="padding:8px 0;font-size:13px;font-weight:600;color:#dc2626;text-align:right;">Expired</td>
              </tr>
              `}
            </table>
          </div>
          <div style="margin-top:24px;padding:18px 20px;border-left:4px solid ${type === 'expired-0' ? '#dc2626' : '#d97706'};background:#fffbeb;border-radius:12px;">
            <p style="margin:0;font-size:13px;line-height:1.7;color:#92400e;">
              <strong>What to do:</strong> ${type !== "expired-0" ? "Contact Medkwik support or your assigned administrator to upgrade your hospital to a permanent subscription and avoid service interruption." : "Please contact Super Admin to renew or upgrade your subscription."}
            </p>
          </div>
        </div>
      </div>
    </div>
  `;

  return { subject, message, html };
};

module.exports = {
  buildAuthEmailTemplate,
  buildDemoExpiryWarningEmail,
  buildDemoExpiryWarningEmailForHospital,
  buildDemoExpiryEmail,
};

