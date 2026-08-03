const PDFDocument = require("pdfkit");

const C = {
  primary:      "#1e3a5f", // Navy blue
  accent:       "#0d9488", // Teal brand
  lightBg:      "#f8fafc",
  textDark:     "#0f172a",
  textMuted:    "#64748b",
  border:       "#e2e8f0",
  white:        "#ffffff",
  tableHdr:     "#1e3a5f",
  tableAlt:     "#f8fafc",
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

const contentWidth = (doc) => doc.page.width - doc.page.margins.left - doc.page.margins.right;
const leftMargin   = (doc) => doc.page.margins.left;

const generateDischargeSummaryPdfBuffer = ({
  summary,
  hospitalLogoBuffer,
  treatments = [],
  consultationFee = 0,
}) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 40,
      info: {
        Title: "Discharge Summary",
        Author: "MedKwik HealthBuddy",
      },
    });

    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    try {
      const pw = contentWidth(doc);
      const left = leftMargin(doc);
      const startY = doc.y;

      // ─── 1. Header (Logo & Hospital Details) ───
      const logoMaxW = 70;
      const logoMaxH = 70;

      if (hospitalLogoBuffer) {
        drawImage(doc, hospitalLogoBuffer, left, startY, { fit: [logoMaxW, logoMaxH] });
      }

      const headerTextX = hospitalLogoBuffer ? left + logoMaxW + 12 : left;
      const headerTextW = hospitalLogoBuffer ? pw - logoMaxW - 12 : pw;

      doc.font("Helvetica-Bold").fontSize(18).fillColor(C.primary)
        .text(safeStr(summary.hospitalName), headerTextX, startY, { width: headerTextW });

      const addressParts = [summary.hospitalAddress].filter(Boolean);
      doc.font("Helvetica").fontSize(9).fillColor(C.textMuted)
        .text(addressParts.join(", ") || "Address not specified", headerTextX, doc.y + 3, { width: headerTextW });

      const contactParts = [
        summary.hospitalPhone ? `Phone: ${summary.hospitalPhone}` : null,
        summary.hospitalEmail ? `Email: ${summary.hospitalEmail}` : null,
        summary.hospitalRegistrationNumber ? `Reg No: ${summary.hospitalRegistrationNumber}` : null,
      ].filter(Boolean).join(" | ");

      if (contactParts) {
        doc.text(contactParts, headerTextX, doc.y + 2, { width: headerTextW });
      }

      const headerEndY = Math.max(doc.y, startY + logoMaxH) + 12;
      doc.moveTo(left, headerEndY).lineTo(left + pw, headerEndY).lineWidth(0.8).strokeColor(C.border).stroke();

      // ─── 2. Title ───
      doc.y = headerEndY + 12;
      doc.font("Helvetica-Bold").fontSize(13).fillColor(C.primary)
        .text("DISCHARGE SUMMARY", left, doc.y, { align: "center", width: pw });

      // ─── 3. Patient Information Card (Gray Block) ───
      doc.y = doc.y + 12;
      const cardStartY = doc.y;
      const cardPadding = 12;
      const cardHeight = 85;

      doc.rect(left, cardStartY, pw, cardHeight).fill(C.lightBg);

      const drawCardText = (label, val, x, y) => {
        doc.font("Helvetica-Bold").fontSize(8).fillColor(C.textMuted).text(label, x, y);
        doc.font("Helvetica").fontSize(8).fillColor(C.textDark).text(safeStr(val), x + 85, y, { width: 140 });
      };

      const cY1 = cardStartY + cardPadding;
      const cY2 = cY1 + 16;
      const cY3 = cY2 + 16;
      const cY4 = cY3 + 16;

      const col2X = left + (pw / 2);

      // Col 1
      drawCardText("Patient Name:", summary.patientName, left + cardPadding, cY1);
       const targetId = (summary.appointmentId && summary.appointmentId.patientUserId) || 
         (summary.patientId && typeof summary.patientId === "object" && summary.patientId._id
           ? summary.patientId._id
           : summary.patientId);
       drawCardText("Patient ID / UHID:", targetId ? buildPatientCode(targetId) : "N/A", left + cardPadding, cY2);
      drawCardText("Age / Gender:", [summary.patientAge ? `${summary.patientAge} Yrs` : null, summary.patientGender].filter(Boolean).join(" / "), left + cardPadding, cY3);
      drawCardText("Blood Group:", summary.patientBloodGroup, left + cardPadding, cY4);

      // Col 2
      drawCardText("IPD / Admission ID:", summary.dischargeId, col2X, cY1);
      drawCardText("Admission Date:", formatDate(summary.admissionDate), col2X, cY2);
      drawCardText("Discharge Date:", formatDate(summary.dischargeDate), col2X, cY3);
      drawCardText("Room / Bed:", [summary.roomNumber ? `Room ${summary.roomNumber}` : null, summary.bedNumber ? `Bed ${summary.bedNumber}` : null].filter(Boolean).join(" - "), col2X, cY4);

      doc.y = cardStartY + cardHeight + 12;

      // ─── 4. Clinical Details Section ───
      const drawSectionHeader = (title) => {
        // Prevent orphaned headers: check if we have enough space
        if (doc.y + 40 > doc.page.height - doc.page.margins.bottom) {
          doc.addPage();
        }
        doc.y = doc.y + 8;
        doc.font("Helvetica-Bold").fontSize(9).fillColor(C.accent)
          .text(title.toUpperCase(), left, doc.y);
        doc.moveTo(left, doc.y + 2).lineTo(left + pw, doc.y + 2).lineWidth(0.5).strokeColor(C.accent).stroke();
        doc.y = doc.y + 6;
      };

      const drawSectionBody = (text) => {
        doc.font("Helvetica").fontSize(9).fillColor(C.textDark)
          .text(safeStr(text, "No details recorded."), left, doc.y, { width: pw, align: "justify" });
        doc.y = doc.y + 6;
      };

      drawSectionHeader("Diagnosis");
      drawSectionBody(summary.diagnosis);

      if (summary.historyAndClinicalSummary) {
        drawSectionHeader("History and Clinical Summary");
        drawSectionBody(summary.historyAndClinicalSummary);
      }

      if (summary.treatmentGiven) {
        drawSectionHeader("Treatment Given");
        drawSectionBody(summary.treatmentGiven);
      }

      if (summary.investigations) {
        drawSectionHeader("Key Investigations / Lab Results");
        drawSectionBody(summary.investigations);
      }

      // Surgery Details
      if (summary.surgeryProcedureName) {
        drawSectionHeader("Surgical Procedure Details");
        const procDetails = [
          `Procedure Name: ${summary.surgeryProcedureName}`,
          summary.surgeryDate ? `Surgery Date: ${formatDate(summary.surgeryDate)}` : null,
          summary.surgeonName ? `Surgeon: Dr. ${summary.surgeonName}` : null,
          summary.anesthesiologistName ? `Anesthesiologist: Dr. ${summary.anesthesiologistName}` : null,
        ].filter(Boolean).join("\n");
        drawSectionBody(procDetails);

        if (summary.surgicalNotes) {
          drawSectionHeader("Surgical Notes");
          drawSectionBody(summary.surgicalNotes);
        }
      }

      if (summary.hospitalCourseSummary) {
        drawSectionHeader("Hospital Course Summary");
        drawSectionBody(summary.hospitalCourseSummary);
      }

      drawSectionHeader("Condition on Discharge");
      drawSectionBody(summary.conditionOnDischarge);

      // ─── IPD Admission Treatments Grouped Sections ───
      const mapCategoryToSection = (category) => {
        const c = String(category).trim();
        if (c === "Medicines") return "Medicines";
        if (c === "Injections") return "Injections";
        if (["Lab Tests", "X-Ray", "CT Scan", "MRI", "ECG"].includes(c)) return "Investigations";
        if (["Surgery/Operation", "Physiotherapy", "Nebulization"].includes(c)) return "Procedures";
        if (["ICU Charges", "Room Charges", "Nursing Charges", "Doctor Visit Charges"].includes(c)) return "Hospital Services";
        if (["Medical Equipment Usage", "Oxygen"].includes(c)) return "Equipment Usage";
        return "Other Treatments";
      };

      const sections = {
        "Medicines": [],
        "Injections": [],
        "Investigations": [],
        "Procedures": [],
        "Hospital Services": [],
        "Equipment Usage": [],
        "Other Treatments": []
      };

      treatments.forEach(t => {
        const sec = mapCategoryToSection(t.category);
        sections[sec].push(t);
      });

      Object.keys(sections).forEach(secName => {
        const list = sections[secName];
        if (list.length > 0) {
          drawSectionHeader(secName);
          
          const colW = [140, 60, 80, 200];
          const tblStartY = doc.y;
          const cellPad = 5;

          doc.rect(left, tblStartY, pw, 15).fill(C.tableHdr);
          
          const drawCell = (text, x, y, w, isHeader = false) => {
            doc.font(isHeader ? "Helvetica-Bold" : "Helvetica")
              .fontSize(7.5)
              .fillColor(isHeader ? C.white : C.textDark)
              .text(text, x + cellPad, y + cellPad - 2, { width: w - cellPad * 2, lineBreak: true });
          };

          drawCell("Item Name", left, tblStartY, colW[0], true);
          drawCell("Quantity", left + colW[0], tblStartY, colW[1], true);
          drawCell("Date/Time", left + colW[0] + colW[1], tblStartY, colW[2], true);
          drawCell("Notes / Description", left + colW[0] + colW[1] + colW[2], tblStartY, colW[3], true);
          
          doc.y = tblStartY + 15;

          list.forEach((item, idx) => {
            if (doc.y + 24 > doc.page.height - doc.page.margins.bottom) {
              doc.addPage();
              const newY = doc.y;
              doc.rect(left, newY, pw, 15).fill(C.tableHdr);
              drawCell("Item Name", left, newY, colW[0], true);
              drawCell("Quantity", left + colW[0], newY, colW[1], true);
              drawCell("Date/Time", left + colW[0] + colW[1], newY, colW[2], true);
              drawCell("Notes / Description", left + colW[0] + colW[1] + colW[2], newY, colW[3], true);
              doc.y = newY + 15;
            }

            const rowY = doc.y;
            const bg = idx % 2 === 1 ? C.tableAlt : C.white;

            doc.rect(left, rowY, pw, 18).fill(bg);
            drawCell(item.treatmentName, left, rowY, colW[0]);
            drawCell(`${item.quantity} ${item.unit || "Qty"}`, left + colW[0], rowY, colW[1]);
            drawCell(new Date(item.dateAndTime).toLocaleDateString("en-IN"), left + colW[0] + colW[1], rowY, colW[2]);
            drawCell(item.notes || item.description || "-", left + colW[0] + colW[1] + colW[2], rowY, colW[3]);

            doc.y = rowY + 18;
          });
          doc.y = doc.y + 6;
        }
      });

      // ─── IPD Final Billing Summary Section ───
      if (treatments.length > 0) {
        drawSectionHeader("Billing Summary");

        const billColW = [240, 100, 140];
        const tblStartY = doc.y;
        const cellPad = 6;

        doc.rect(left, tblStartY, pw, 15).fill(C.tableHdr);
        
        const drawBillCell = (text, x, y, w, isHeader = false, align = "left") => {
          doc.font(isHeader ? "Helvetica-Bold" : "Helvetica")
            .fontSize(8)
            .fillColor(isHeader ? C.white : C.textDark)
            .text(text, x + cellPad, y + cellPad - 2, { width: w - cellPad * 2, align, lineBreak: false });
        };

        drawBillCell("Category / Item", left, tblStartY, billColW[0], true);
        drawBillCell("Quantity Logs", left + billColW[0], tblStartY, billColW[1], true, "right");
        drawBillCell("Total Charge (INR)", left + billColW[0] + billColW[1], tblStartY, billColW[2], true, "right");

        doc.y = tblStartY + 15;

        const billGroup = {};
        let subtotal = 0;
        treatments.forEach((t) => {
          subtotal += t.totalAmount;
          if (!billGroup[t.category]) {
            billGroup[t.category] = { count: 0, amount: 0 };
          }
          billGroup[t.category].count += t.quantity;
          billGroup[t.category].amount += t.totalAmount;
        });

        if (consultationFee > 0) {
          subtotal += consultationFee;
          billGroup["Consultation"] = {
            count: 1,
            amount: consultationFee,
          };
        }

        Object.keys(billGroup).forEach((cat, idx) => {
          if (doc.y + 20 > doc.page.height - doc.page.margins.bottom) {
            doc.addPage();
            const newY = doc.y;
            doc.rect(left, newY, pw, 15).fill(C.tableHdr);
            drawBillCell("Category / Item", left, newY, billColW[0], true);
            drawBillCell("Quantity Logs", left + billColW[0], newY, billColW[1], true, "right");
            drawBillCell("Total Charge (INR)", left + billColW[0] + billColW[1], newY, billColW[2], true, "right");
            doc.y = newY + 15;
          }

          const rowY = doc.y;
          const bg = idx % 2 === 1 ? C.tableAlt : C.white;
          doc.rect(left, rowY, pw, 18).fill(bg);
          
          drawBillCell(cat, left, rowY, billColW[0]);
          drawBillCell(String(billGroup[cat].count), left + billColW[0], rowY, billColW[1], false, "right");
          drawBillCell(`Rs. ${billGroup[cat].amount.toFixed(2)}`, left + billColW[0] + billColW[1], rowY, billColW[2], false, "right");

          doc.y = rowY + 18;
        });

        const tax = Math.round((subtotal * 0.18) * 100) / 100;
        const total = subtotal;

        const drawTotalRow = (label, amt, isBold = false) => {
          if (doc.y + 20 > doc.page.height - doc.page.margins.bottom) {
            doc.addPage();
          }
          const rowY = doc.y;
          doc.font(isBold ? "Helvetica-Bold" : "Helvetica")
            .fontSize(8.5)
            .fillColor(C.textDark)
            .text(label, left + billColW[0], rowY + cellPad - 2, { width: billColW[1], align: "right" })
            .text(`Rs. ${amt.toFixed(2)}`, left + billColW[0] + billColW[1], rowY + cellPad - 2, { width: billColW[2], align: "right" });
          doc.y = rowY + 16;
        };

        doc.moveTo(left + billColW[0], doc.y).lineTo(left + pw, doc.y).lineWidth(0.5).strokeColor(C.border).stroke();
        doc.y = doc.y + 4;
        
        drawTotalRow("Subtotal (Incl. GST):", subtotal);
        drawTotalRow("Tax/GST (18% - Incl.):", tax);
        
        doc.moveTo(left + billColW[0], doc.y).lineTo(left + pw, doc.y).lineWidth(0.8).strokeColor(C.primary).stroke();
        doc.y = doc.y + 4;
        
        drawTotalRow("Grand Total Amount:", total, true);
      }

      // ─── 5. Continuing Medications ───
      if (Array.isArray(summary.medications) && summary.medications.length > 0) {
        drawSectionHeader("Medicines to Continue");

        const tblStartY = doc.y;
        const colW = [180, 80, 110, 110]; // Sum matches pw (480pt on A4 with 40pt margins)
        const cellPad = 6;

        // Draw Table Header
        doc.rect(left, tblStartY, pw, 18).fill(C.tableHdr);

        const drawCell = (text, x, y, w, isHeader = false) => {
          doc.font(isHeader ? "Helvetica-Bold" : "Helvetica")
            .fontSize(8)
            .fillColor(isHeader ? C.white : C.textDark)
            .text(text, x + cellPad, y + cellPad - 2, { width: w - cellPad * 2, lineBreak: false });
        };

        drawCell("Medicine Name", left, tblStartY, colW[0], true);
        drawCell("Dose", left + colW[0], tblStartY, colW[1], true);
        drawCell("Frequency", left + colW[0] + colW[1], tblStartY, colW[2], true);
        drawCell("Duration", left + colW[0] + colW[1] + colW[2], tblStartY, colW[3], true);

        doc.y = tblStartY + 18;

        summary.medications.forEach((med, idx) => {
          if (doc.y + 20 > doc.page.height - doc.page.margins.bottom) {
            doc.addPage();
            // Redraw headers on new page
            const newY = doc.y;
            doc.rect(left, newY, pw, 18).fill(C.tableHdr);
            drawCell("Medicine Name", left, newY, colW[0], true);
            drawCell("Dose", left + colW[0], newY, colW[1], true);
            drawCell("Frequency", left + colW[0] + colW[1], newY, colW[2], true);
            drawCell("Duration", left + colW[0] + colW[1] + colW[2], newY, colW[3], true);
            doc.y = newY + 18;
          }

          const rowY = doc.y;
          const bg = idx % 2 === 1 ? C.tableAlt : C.white;

          doc.rect(left, rowY, pw, 18).fill(bg);
          drawCell(med.medicineName, left, rowY, colW[0]);
          drawCell(med.dose || "-", left + colW[0], rowY, colW[1]);
          drawCell(med.frequency || "-", left + colW[0] + colW[1], rowY, colW[2]);
          drawCell(med.duration || "-", left + colW[0] + colW[1] + colW[2], rowY, colW[3]);

          doc.y = rowY + 18;
        });
      }

      // ─── 6. Follow-up ───
      if (summary.followUpDate || summary.followUpInstructions) {
        drawSectionHeader("Follow-Up Instructions");
        let adviceText = "";
        if (summary.followUpDate) {
          adviceText += `Scheduled Follow-Up Date: ${formatDate(summary.followUpDate)}\n`;
        }
        if (summary.followUpInstructions) {
          adviceText += summary.followUpInstructions;
        }
        drawSectionBody(adviceText);
      }

      // ─── 7. Signatures Footer ───
      // Add page if bottom is too close
      if (doc.y + 100 > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
      }

      const signY = doc.y + 40;
      doc.y = signY;

      // Hospital Seal Area
      doc.rect(left + 20, signY - 20, 80, 50).lineWidth(0.5).strokeColor(C.border).stroke();
      doc.font("Helvetica").fontSize(6).fillColor(C.textMuted)
        .text("HOSPITAL SEAL", left + 20, signY + 2, { width: 80, align: "center" });

      // Doctor signature line
      const docSignX = left + pw - 150;
      doc.moveTo(docSignX, signY + 20).lineTo(left + pw, signY + 20).lineWidth(0.5).strokeColor(C.textMuted).stroke();
      doc.font("Helvetica-Bold").fontSize(8).fillColor(C.textDark)
        .text(`Dr. ${summary.doctorName}`, docSignX, signY + 25, { width: 150, align: "center" });
      doc.font("Helvetica").fontSize(7).fillColor(C.textMuted)
        .text(summary.doctorDepartment || "Medical Consultant", docSignX, doc.y + 1, { width: 150, align: "center" });
      if (summary.doctorRegistrationNumber) {
        doc.text(`Reg: ${summary.doctorRegistrationNumber}`, docSignX, doc.y + 1, { width: 150, align: "center" });
      }

      // Footer branding
      doc.fontSize(7).fillColor(C.textMuted)
        .text("Generated by MedKwik HealthBuddy", left, doc.page.height - 24, { align: "center", width: pw });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
};

module.exports = {
  generateDischargeSummaryPdfBuffer,
};
