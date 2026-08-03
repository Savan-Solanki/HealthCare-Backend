const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

// ─── Colour palette ───────────────────────────────────────────────────────────
const C = {
  primary:      "#1e3a5f",
  accent:       "#0d9488",
  lightBlueBg:  "#f0f7ff",
  lightBlueBdr: "#bfdbfe",
  tableHdr:     "#1e3a5f",
  tableAlt:     "#f8fafc",
  textDark:     "#0f172a",
  textMuted:    "#64748b",
  border:       "#e2e8f0",
  warnBg:       "#fffbeb",
  warnBorder:   "#fcd34d",
  warnText:     "#92400e",
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
    timeZone: "Asia/Kolkata",
  });
};

const safeStr = (v, fallback = "Not specified") =>
  v !== null && v !== undefined && String(v).trim() !== "" ? String(v).trim() : fallback;

const joinAddress = (hospital) =>
  [
    hospital?.address,
    hospital?.city,
    hospital?.state,
  ]
    .filter(Boolean)
    .join(", ");

const getHospitalName = ({ hospital, prescription }) =>
  hospital?.name || prescription?.hospitalName || "MedKwik HealthBuddy";

const getHospitalAddress = ({ hospital, prescription }) =>
  joinAddress(hospital) || prescription?.hospitalAddress || "Address not specified";

const getMedicineSchedule = (medicine) => {
  const schedule = medicine?.schedule || {};
  const entries = [
    ["Morning",   schedule.morning,   schedule.morningTime],
    ["Afternoon", schedule.afternoon, schedule.afternoonTime],
    ["Night",     schedule.night,     schedule.nightTime],
  ]
    .filter(([, enabled]) => Boolean(enabled))
    .map(([label, , time]) => (time ? `${label} ${time}` : label));

  return entries.length ? entries.join(" / ") : safeStr(medicine.frequency, "-");
};

const contentWidth = (doc) => doc.page.width - doc.page.margins.left - doc.page.margins.right;
const leftMargin   = (doc) => doc.page.margins.left;
const bottomEdge   = (doc) => doc.page.height - doc.page.margins.bottom;

const collectPdfBuffer = (asyncWriter) =>
  new Promise(async (resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 46,
      info: {
        Title: "Prescription",
        Author: "MedKwik HealthBuddy",
      },
    });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    try {
      await asyncWriter(doc);
    } catch (err) {
      reject(err);
      return;
    }
    doc.end();
  });

const drawImage = (doc, buffer, x, y, opts = {}) => {
  if (!buffer || !buffer.length) return false;
  try {
    doc.image(buffer, x, y, opts);
    return true;
  } catch {
    return false;
  }
};

const ensureSpace = (doc, neededHeight) => {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + neededHeight > bottom) {
    doc.addPage();
  }
};

// ─── SECTION 1: Header (3-column) ────────────────────────────────────────────────
const drawHeader = (doc, { hospital, prescription, hospitalLogoBuffer }) => {
  const pw     = contentWidth(doc);
  const left   = leftMargin(doc);
  const startY = doc.y;
  const colL   = pw * 0.22;
  const colC   = pw * 0.53;
  const logoMaxW = 80;
  const logoMaxH = 80;

  // Left: hospital logo
  drawImage(doc, hospitalLogoBuffer, left, startY, {
    fit: [logoMaxW, logoMaxH],
    align: "left",
    valign: "top",
  });

  // Centre: hospital name / address / contact
  const cX = left + colL + 6;
  const cW = colC;

  doc.font("Helvetica-Bold").fontSize(18).fillColor(C.primary)
    .text(getHospitalName({ hospital, prescription }), cX, startY, { width: cW });

  doc.font("Helvetica").fontSize(9).fillColor(C.textMuted)
    .text(getHospitalAddress({ hospital, prescription }), cX, doc.y, { width: cW });

  const contactParts = [];
  if (hospital?.phone) contactParts.push("Phone: " + hospital.phone);
  if (hospital?.email) contactParts.push("Email: " + hospital.email);
  if (contactParts.length) {
    doc.font("Helvetica").fontSize(9).fillColor(C.textMuted)
      .text(contactParts.join("  |  "), cX, doc.y, { width: cW });
  }

  const contactLineY = doc.y + 3;
  doc.moveTo(cX, contactLineY).lineTo(cX + cW, contactLineY)
    .strokeColor(C.border).lineWidth(0.5).stroke();

  // Right: Rx No + Date
  const rX = left + colL + colC + 6;
  const rW = pw * 0.25;

  doc.font("Helvetica-Bold").fontSize(9).fillColor(C.accent)
    .text("Rx No: " + safeStr(prescription.prescriptionNumber, "N/A"), rX, startY, {
      width: rW,
      align: "right",
    });
  doc.font("Helvetica").fontSize(9).fillColor(C.textMuted)
    .text("Date: " + formatDate(prescription.prescriptionDate), rX, doc.y + 4, {
      width: rW,
      align: "right",
    });

  // Thick bottom rule
  const ruleY = Math.max(doc.y, startY + logoMaxH) + 10;
  doc.moveTo(left, ruleY).lineTo(left + pw, ruleY)
    .strokeColor(C.primary).lineWidth(2).stroke();
  doc.y = ruleY + 12;
};

// ─── SECTION 2: Patient & Doctor info card ────────────────────────────────────
const drawInfoCard = (doc, { doctorName, patient, prescription }) => {
  ensureSpace(doc, 140);
  const pw     = contentWidth(doc);
  const left   = leftMargin(doc);
  const startY = doc.y;

  const patientName   = safeStr(prescription.patientName || patient?.name);
  const patientAge    = safeStr(prescription.patientAge ?? patient?.age, "-");
  const patientGender = safeStr(prescription.patientGender || patient?.gender, "-");
  const patientMobile = safeStr(prescription.patientMobile || patient?.phone, "-");
  const bloodGroup    = patient?.bloodGroup || null;
  const ageGender     = bloodGroup
    ? `${patientAge}y / ${patientGender} / ${bloodGroup}`
    : `${patientAge}y / ${patientGender}`;
  const doctorDisplay  = safeStr(doctorName);
  const specialization = safeStr(prescription.doctorSpecialization);
  const regNo          = safeStr(prescription.doctorRegistrationNumber);
  const diagnosis      = safeStr(prescription.diagnosis);

  const cardPad = 14;
  const rowH    = 32;
  const cardH   = cardPad + rowH * 3 + 30 + cardPad;

  doc.roundedRect(left, startY, pw, cardH, 8).fillColor(C.lightBlueBg).fill();
  doc.roundedRect(left, startY, pw, cardH, 8).strokeColor(C.lightBlueBdr).lineWidth(1).stroke();

  const innerLeft = left + cardPad;
  const half      = (pw - cardPad * 2) / 2;
  const col2X     = innerLeft + half + 10;

  const drawField = (label, value, x, y, w) => {
    doc.font("Helvetica-Bold").fontSize(7).fillColor(C.textMuted)
      .text(label.toUpperCase(), x, y, { width: w });
    doc.font("Helvetica-Bold").fontSize(10).fillColor(C.textDark)
      .text(value, x, y + 9, { width: w });
  };

  let rowY = startY + cardPad;
  drawField("Patient Name",   patientName,    innerLeft, rowY, half);
  drawField("Doctor",         doctorDisplay,  col2X,     rowY, half - 10);
  rowY += rowH;
  drawField("Age / Gender",   ageGender,      innerLeft, rowY, half);
  drawField("Specialization", specialization, col2X,     rowY, half - 10);
  rowY += rowH;
  drawField("Mobile",         patientMobile,  innerLeft, rowY, half);
  drawField("Reg. No.",       regNo,          col2X,     rowY, half - 10);
  rowY += rowH;

  doc.font("Helvetica-Bold").fontSize(7).fillColor(C.textMuted)
    .text("DIAGNOSIS", innerLeft, rowY, { width: pw - cardPad * 2 });
  doc.font("Helvetica-Bold").fontSize(10).fillColor(C.accent)
    .text(diagnosis, innerLeft, rowY + 9, { width: pw - cardPad * 2 });

  doc.y = startY + cardH + 14;
};

// ─── SECTION 3: Medicines table ───────────────────────────────────────────────────
const drawMedicinesTable = (doc, medicines) => {
  if (!medicines || medicines.length === 0) return;
  ensureSpace(doc, 60);
  const pw   = contentWidth(doc);
  const left = leftMargin(doc);

  doc.font("Helvetica-Bold").fontSize(11).fillColor(C.primary)
    .text("Medicines", left, doc.y);
  doc.y += 8;

  const cols = [
    { label: "#",         w: pw * 0.05 },
    { label: "Medicine",  w: pw * 0.28 },
    { label: "Dosage",    w: pw * 0.13 },
    { label: "Frequency", w: pw * 0.16 },
    { label: "Duration",  w: pw * 0.13 },
    { label: "Timing",    w: pw * 0.25 },
  ];
  const hdrH    = 22;
  const rowPadX = 5;
  const rowPadY = 6;
  const minRowH = 28;
  const FONT_HDR  = 8;
  const FONT_CELL = 8.5;

  // Header row
  let tableY = doc.y;
  let colX   = left;
  cols.forEach((col) => {
    doc.rect(colX, tableY, col.w, hdrH).fillColor(C.tableHdr).fill();
    doc.font("Helvetica-Bold").fontSize(FONT_HDR).fillColor(C.white)
      .text(col.label, colX + rowPadX, tableY + 7, {
        width: col.w - rowPadX * 2,
        align: "left",
        lineBreak: false,
      });
    colX += col.w;
  });
  tableY += hdrH;

  // Data rows
  medicines.forEach((med, idx) => {
    const timing = getMedicineSchedule(med);
    const cells  = [
      String(idx + 1),
      safeStr(med.medicineName),
      safeStr(med.dosage),
      safeStr(med.frequency),
      safeStr(med.duration),
      timing,
    ];
    let rowH = minRowH;
    cells.forEach((text, ci) => {
      const approxLines = Math.ceil(
        (text.length * (FONT_CELL * 0.55)) / (cols[ci].w - rowPadX * 2)
      );
      const est = approxLines * (FONT_CELL + 3) + rowPadY * 2;
      if (est > rowH) rowH = est;
    });
    ensureSpace(doc, rowH + 2);
    if (doc.y !== tableY) tableY = doc.y;
    const fillColor = idx % 2 === 0 ? C.white : C.tableAlt;
    colX = left;
    cols.forEach((col, ci) => {
      doc.rect(colX, tableY, col.w, rowH).fillColor(fillColor).fill();
      doc.rect(colX, tableY, col.w, rowH).strokeColor(C.border).lineWidth(0.5).stroke();
      const font = ci === 1 ? "Helvetica-Bold" : "Helvetica";
      doc.font(font).fontSize(FONT_CELL).fillColor(C.textDark)
        .text(cells[ci], colX + rowPadX, tableY + rowPadY, {
          width: col.w - rowPadX * 2,
          lineBreak: true,
        });
      colX += col.w;
    });
    tableY += rowH;
  });
  doc.y = tableY + 14;
};

// ─── SECTION 4: Instructions box (conditional) ───────────────────────────────────
const drawInstructions = (doc, instruction) => {
  if (!instruction) return;
  ensureSpace(doc, 70);
  const pw   = contentWidth(doc);
  const left = leftMargin(doc);
  const pad  = 12;
  const approxTextH = Math.ceil(instruction.length / 90) * 14 + 30;
  const boxH = approxTextH < 50 ? 50 : approxTextH;
  const boxStartY = doc.y;

  doc.roundedRect(left, boxStartY, pw, boxH, 6).fillColor(C.warnBg).fill();
  doc.rect(left, boxStartY, 4, boxH).fillColor(C.warnBorder).fill();
  doc.font("Helvetica-Bold").fontSize(9).fillColor(C.warnText)
    .text("Instructions", left + pad + 4, boxStartY + pad, { width: pw - pad * 2 });
  doc.font("Helvetica").fontSize(9).fillColor(C.textDark)
    .text(instruction, left + pad + 4, doc.y + 4, { width: pw - pad * 2, lineGap: 2 });
  doc.y = boxStartY + boxH + 14;
};

// ─── SECTION 5: Follow-up & Doctor Notes ───────────────────────────────────────
const drawFollowUpNotes = (doc, { followUpDate, doctorNotes }) => {
  const hasFU    = !!followUpDate;
  const hasNotes = !!doctorNotes;
  if (!hasFU && !hasNotes) return;
  ensureSpace(doc, 70);
  const pw     = contentWidth(doc);
  const left   = leftMargin(doc);
  const half   = (pw - 8) / 2;
  const pad    = 10;
  const boxH   = 52;
  const startY = doc.y;

  const drawBox = (x, w, label, value) => {
    doc.roundedRect(x, startY, w, boxH, 6).fillColor(C.lightBlueBg).fill();
    doc.roundedRect(x, startY, w, boxH, 6).strokeColor(C.lightBlueBdr).lineWidth(0.5).stroke();
    doc.font("Helvetica-Bold").fontSize(7).fillColor(C.textMuted)
      .text(label.toUpperCase(), x + pad, startY + pad, { width: w - pad * 2 });
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(C.textDark)
      .text(value, x + pad, startY + pad + 11, { width: w - pad * 2 });
  };

  drawBox(left,            half, "Next Visit Date", formatDate(followUpDate));
  drawBox(left + half + 8, half, "Doctor Notes",    safeStr(doctorNotes, "-"));
  doc.y = startY + boxH + 14;
};

// ─── SECTIONS 6 & 7: Signature + QR code ───────────────────────────────────────
const drawSignatureAndQR = (doc, { doctorName, prescription, qrBuffer }) => {
  ensureSpace(doc, 90);
  const pw     = contentWidth(doc);
  const left   = leftMargin(doc);
  const startY = doc.y;
  const qrSize = 64;
  const sigW   = 160;
  const sigX   = left + pw - sigW;

  if (qrBuffer) {
    drawImage(doc, qrBuffer, left, startY, { width: qrSize, height: qrSize });
    doc.font("Helvetica").fontSize(7).fillColor(C.textMuted)
      .text("Scan to verify", left, startY + qrSize + 3, { width: qrSize, align: "center" });
  }

  const sigLineY = startY + 50;
  doc.moveTo(sigX, sigLineY).lineTo(sigX + sigW, sigLineY)
    .strokeColor(C.textDark).lineWidth(0.75).stroke();
  doc.font("Helvetica-Bold").fontSize(10).fillColor(C.textDark)
    .text("Dr. " + safeStr(doctorName), sigX, sigLineY + 5, { width: sigW, align: "center" });
  doc.font("Helvetica").fontSize(8).fillColor(C.textMuted)
    .text(safeStr(prescription.doctorSpecialization, ""), sigX, doc.y + 2, {
      width: sigW,
      align: "center",
    });
  doc.font("Helvetica").fontSize(8).fillColor(C.textMuted)
    .text(
      prescription.doctorRegistrationNumber
        ? "Reg. No. " + prescription.doctorRegistrationNumber
        : "",
      sigX, doc.y + 2,
      { width: sigW, align: "center" }
    );
  doc.y = Math.max(doc.y, startY + qrSize + 20) + 10;
};

// ─── SECTION 8: Footer ──────────────────────────────────────────────────────────────
const drawFooter = (doc, { prescription, medikwikLogoBuffer }) => {
  ensureSpace(doc, 30);
  const pw       = contentWidth(doc);
  const left     = leftMargin(doc);
  const startY   = doc.y;
  const showmedikwik =
    prescription.includemedikwikLogo === true && medikwikLogoBuffer;

  doc.font("Helvetica").fontSize(7).fillColor(C.textMuted)
    .text("Prescription ID: " + prescription._id, left, startY, { width: pw * 0.6 });

  if (showmedikwik) {
    const logoW  = 24;
    const brandW = 180;
    const brandX = left + pw - brandW;
    drawImage(doc, medikwikLogoBuffer, brandX, startY - 4, { width: logoW, height: logoW });
    doc.font("Helvetica").fontSize(7).fillColor(C.textMuted)
      .text("Powered by medikwik HealthBuddy", brandX + logoW + 4, startY + 2, {
        width: brandW - logoW - 8,
        align: "left",
      });
  }
};

// ─── Main exported function ───────────────────────────────────────────────────────────
const generateDoctorPrescriptionPdfBuffer = async ({
  doctorName,
  hospital,
  patient,
  prescription,
  hospitalLogoBuffer = null,
  medikwikLogoBuffer = null,
}) => {
  // Pre-generate QR (async, outside PDFKit stream)
  let qrBuffer = null;
  try {
    qrBuffer = await QRCode.toBuffer(String(prescription._id), {
      type:   "png",
      width:  64,
      margin: 1,
    });
  } catch { /* non-fatal — QR simply won't appear */ }

  return collectPdfBuffer(async (doc) => {
    drawHeader(doc, { hospital, prescription, hospitalLogoBuffer });
    drawInfoCard(doc, { doctorName, patient, prescription });
    drawMedicinesTable(doc, prescription.medicines || []);
    drawInstructions(doc, prescription.instruction);
    drawFollowUpNotes(doc, {
      followUpDate: prescription.followUpDate,
      doctorNotes:  prescription.doctorNotes,
    });
    drawSignatureAndQR(doc, { doctorName, prescription, qrBuffer });
    drawFooter(doc, { prescription, medikwikLogoBuffer });
  });
};


const generateUploadedPrescriptionPdfBuffer = ({
  file,
  patientUser,
  prescription,
}) =>
  collectPdfBuffer((doc) => {
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    doc
      .font("Helvetica-Bold")
      .fontSize(18)
      .fillColor("#0f766e")
      .text("Uploaded Prescription", { width: pageWidth });

    doc
      .moveDown(0.5)
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#475569")
      .text(`Patient: ${patientUser.name}`)
      .text(`Prescription date: ${formatDate(prescription.prescriptionDate)}`)
      .text(`Doctor: ${prescription.doctorName || "Not specified"}`)
      .text(`Hospital: ${prescription.hospitalName || "Not specified"}`)
      .text(`Address: ${prescription.hospitalAddress || "Not specified"}`);

    const divY = doc.y + 8;
    doc
      .moveTo(doc.page.margins.left, divY)
      .lineTo(doc.page.width - doc.page.margins.right, divY)
      .strokeColor("#dbe4ea")
      .lineWidth(1)
      .stroke();
    doc.moveDown(1.1);

    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#64748b")
      .text(`Original file: ${file.originalname}`, { width: pageWidth })
      .text("The prescription image below was uploaded by the patient account.", {
        width: pageWidth,
      });

    doc.addPage();

    const imageMaxWidth = pageWidth;
    const imageMaxHeight = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;

    doc.image(file.buffer, doc.page.margins.left, doc.page.margins.top, {
      fit: [imageMaxWidth, imageMaxHeight],
      align: "center",
      valign: "center",
    });
  });

module.exports = {
  generateDoctorPrescriptionPdfBuffer,
  generateUploadedPrescriptionPdfBuffer,
};
