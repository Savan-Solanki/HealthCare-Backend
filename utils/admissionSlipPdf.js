const PDFDocument = require("pdfkit");

const C = {
  primary:      "#0f172a", // Sleek charcoal/navy
  accent:       "#0d9488", // Teal brand
  lightBg:      "#f8fafc",
  textDark:     "#1e293b",
  textMuted:    "#64748b",
  border:       "#e2e8f0",
  white:        "#ffffff",
};

const formatDate = (value) => {
  if (!value) return "Not specified";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not specified";
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
};

const safeStr = (v, fallback = "N/A") =>
  v !== null && v !== undefined && String(v).trim() !== "" ? String(v).trim() : fallback;

const buildPatientCode = (value) => {
  const clean = String(value || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return `MW-${(clean.slice(-6) || "000000").padStart(6, "0")}`;
};

const drawImage = (doc, buffer, x, y, opts = {}) => {
  if (!buffer || !buffer.length) return false;
  try {
    doc.image(buffer, x, y, opts);
    return true;
  } catch {
    return false;
  }
};

const generateAdmissionSlipPdfBuffer = ({
  hospital,
  patient,
  admission,
  hospitalLogoBuffer,
}) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A5", // A5 size is standard for slips
      margin: 30,
      layout: "portrait",
      info: {
        Title: "Admission Slip",
        Author: "MedKwik HealthBuddy",
      },
    });

    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    try {
      const pw = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const left = doc.page.margins.left;
      const startY = doc.y;

      // ─── Header Section ───
      const logoMaxW = 50;
      const logoMaxH = 50;

      if (hospitalLogoBuffer) {
        drawImage(doc, hospitalLogoBuffer, left, startY, { fit: [logoMaxW, logoMaxH] });
      }

      const headerTextX = hospitalLogoBuffer ? left + logoMaxW + 8 : left;
      const headerTextW = hospitalLogoBuffer ? pw - logoMaxW - 8 : pw;

      doc.font("Helvetica-Bold").fontSize(14).fillColor(C.primary)
        .text(hospital?.name || "MedKwik Partner Hospital", headerTextX, startY, { width: headerTextW });

      const addressLine = [hospital?.address, hospital?.city, hospital?.state].filter(Boolean).join(", ");
      doc.font("Helvetica").fontSize(7).fillColor(C.textMuted)
        .text(addressLine || "Address not specified", headerTextX, doc.y + 2, { width: headerTextW });

      const contactLine = [
        hospital?.phone ? `Tel: ${hospital.phone}` : null,
        hospital?.email ? `Email: ${hospital.email}` : null,
        hospital?.registrationNumber ? `Reg: ${hospital.registrationNumber}` : null,
      ].filter(Boolean).join(" | ");
      if (contactLine) {
        doc.text(contactLine, headerTextX, doc.y + 1, { width: headerTextW });
      }

      const headerEndY = Math.max(doc.y, startY + logoMaxH) + 12;
      doc.moveTo(left, headerEndY).lineTo(left + pw, headerEndY).lineWidth(0.5).strokeColor(C.border).stroke();

      // ─── Slip Title ───
      doc.y = headerEndY + 12;
      doc.font("Helvetica-Bold").fontSize(11).fillColor(C.accent)
        .text("PATIENT ADMISSION SLIP", left, doc.y, { align: "center", width: pw });

      // ─── Details Grid ───
      const gridY = doc.y + 16;
      doc.y = gridY;

      const drawRow = (label1, val1, label2, val2) => {
        const colW = pw / 2;
        const currentY = doc.y;

        // Col 1
        doc.font("Helvetica-Bold").fontSize(8).fillColor(C.textMuted)
          .text(label1, left, currentY, { width: 70 });
        doc.font("Helvetica").fontSize(8).fillColor(C.textDark)
          .text(safeStr(val1), left + 75, currentY, { width: colW - 80 });

        // Col 2
        if (label2) {
          doc.font("Helvetica-Bold").fontSize(8).fillColor(C.textMuted)
            .text(label2, left + colW, currentY, { width: 70 });
          doc.font("Helvetica").fontSize(8).fillColor(C.textDark)
            .text(safeStr(val2), left + colW + 75, currentY, { width: colW - 80 });
        }

        doc.y = Math.max(doc.y, currentY + 12);
      };

      drawRow("Admission ID:", admission.admissionId, "Admission Date:", formatDate(admission.admissionDate));
      const targetId = (admission.appointmentId && admission.appointmentId.patientUserId) || patient?._id || admission.patientRecordId;
      drawRow("Patient Name:", admission.patientName, "Patient ID:", targetId ? buildPatientCode(targetId) : "N/A");
      drawRow("Age / Gender:", [patient?.age ? `${patient.age} Yrs` : null, patient?.gender].filter(Boolean).join(" / "), "Blood Group:", patient?.bloodGroup || "N/A");
      drawRow("Admitting Doctor:", admission.doctorName, "Department:", admission.department || "General");
      drawRow("Room / Ward:", admission.roomNumber, "Bed Number:", admission.bedNumber);

      // Line spacer
      doc.y = doc.y + 8;
      doc.moveTo(left, doc.y).lineTo(left + pw, doc.y).lineWidth(0.5).strokeColor(C.border).stroke();

      // ─── Reason and Notes ───
      doc.y = doc.y + 8;
      doc.font("Helvetica-Bold").fontSize(8).fillColor(C.textMuted)
        .text("Reason for Admission:", left, doc.y);
      doc.font("Helvetica").fontSize(8).fillColor(C.textDark)
        .text(admission.admissionReason, left, doc.y + 3, { width: pw });

      if (admission.notes) {
        doc.y = doc.y + 8;
        doc.font("Helvetica-Bold").fontSize(8).fillColor(C.textMuted)
          .text("Admission Notes / Instructions:", left, doc.y);
        doc.font("Helvetica").fontSize(8).fillColor(C.textDark)
          .text(admission.notes, left, doc.y + 3, { width: pw });
      }

      // ─── Signatures ───
      const signY = doc.page.height - doc.page.margins.bottom - 40;
      doc.y = signY;

      doc.moveTo(left, signY).lineTo(left + 100, signY).lineWidth(0.5).strokeColor(C.textMuted).stroke();
      doc.font("Helvetica").fontSize(7).fillColor(C.textMuted)
        .text("Authorized Signature", left, signY + 3, { width: 100, align: "center" });

      doc.moveTo(left + pw - 100, signY).lineTo(left + pw, signY).lineWidth(0.5).strokeColor(C.textMuted).stroke();
      doc.font("Helvetica").fontSize(7).fillColor(C.textMuted)
        .text("Doctor/Staff Signature", left + pw - 100, signY + 3, { width: 100, align: "center" });

      // Footer brand
      doc.fontSize(6).fillColor(C.textMuted)
        .text("Powered by MedKwik HealthBuddy", left, doc.page.height - 18, { align: "center", width: pw });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
};

module.exports = {
  generateAdmissionSlipPdfBuffer,
};
