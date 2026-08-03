const PDFDocument = require("pdfkit");

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

const formatTime = (value) => {
  if (!value) return "Not specified";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not specified";
  return date.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
};

const buildPatientCode = (value) => {
  const clean = String(value || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return `MW-${(clean.slice(-6) || "000000").padStart(6, "0")}`;
};

const collectPdfBuffer = (writer) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 46,
      info: {
        Title: "Bill Receipt",
        Author: "MedKwik HealthBuddy",
      },
    });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    writer(doc);
    doc.end();
  });

const addDivider = (doc, yOffset = 8) => {
  const y = doc.y + yOffset;
  doc.moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .strokeColor("#dbe4ea")
    .lineWidth(1)
    .stroke();
  doc.moveDown(1.1);
};

const addLabelValue = (doc, label, value, x, y, width) => {
  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor("#64748b")
    .text(label.toUpperCase(), x, y, { width });
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#0f172a")
    .text(value || "Not specified", x, y + 13, { width });
};

const drawHeaderLogo = (doc, buffer, x, y, maxWidth, maxHeight) => {
  if (!buffer?.length) return false;

  try {
    doc.image(buffer, x, y, {
      fit: [maxWidth, maxHeight],
      align: "left",
      valign: "top",
    });
    return true;
  } catch {
    return false;
  }
};

const generateReceiptPdfBuffer = ({
  receipt,
  patient,
  doctor,
  hospital,
  hospitalLogoBuffer = null,
  patientUserId,
}) =>
  collectPdfBuffer((doc) => {
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const left = doc.page.margins.left;
    const headerStartY = doc.y;
    const logoHeight = 52;
    const logoWidth = 72;
    let textOffsetX = 0;

    // Logo on left side
    if (hospitalLogoBuffer) {
      const drewHospitalLogo = drawHeaderLogo(
        doc,
        hospitalLogoBuffer,
        left,
        headerStartY,
        logoWidth,
        logoHeight
      );
      if (drewHospitalLogo) {
        textOffsetX = logoWidth + 14;
      }
    }

    const textX = left + textOffsetX;
    const textWidth = pageWidth - textOffsetX;

    // Hospital Details on right side
    doc
      .font("Helvetica-Bold")
      .fontSize(18)
      .fillColor("#0f766e")
      .text(hospital?.name || "MedKwik HealthBuddy", textX, headerStartY, {
        width: textWidth,
      });

    const addressStr = [hospital?.address, hospital?.city, hospital?.state]
      .filter(Boolean)
      .join(", ");

    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#475569")
      .text(addressStr || "Address not specified", textX, doc.y + 2, {
        width: textWidth,
      });

    let contactStr = "";
    if (hospital?.phone) contactStr += `Phone: ${hospital.phone}`;
    if (hospital?.email) contactStr += `${contactStr ? "  |  " : ""}Email: ${hospital.email}`;
    if (hospital?.website) contactStr += `${contactStr ? "  |  " : ""}Web: ${hospital.website}`;

    if (contactStr) {
      doc.text(contactStr, textX, doc.y + 2, { width: textWidth });
    }

    doc.y = Math.max(doc.y, headerStartY + logoHeight + 8);
    addDivider(doc, 4);

    // Title: BILL RECEIPT (Center)
    doc
      .font("Helvetica-Bold")
      .fontSize(14)
      .fillColor("#0f172a")
      .text("BILL RECEIPT", left, doc.y, { align: "center", width: pageWidth });
    
    doc.moveDown(0.8);

    // Patient and Receipt metadata Grid
    const detailY = doc.y;
    const colWidth = (pageWidth - 18) / 2;

    const patientIdVal = patientUserId || patient?._id || receipt.patientId;
    const patientCode = patientIdVal ? buildPatientCode(patientIdVal) : "N/A";

    // Row 1
    addLabelValue(doc, "Receipt Number", receipt.receiptNumber, left, detailY, colWidth);
    addLabelValue(
      doc,
      "Date & Time",
      `${formatDate(receipt.createdAt)} ${formatTime(receipt.createdAt)}`,
      left + colWidth + 18,
      detailY,
      colWidth
    );

    // Row 2
    addLabelValue(
      doc,
      "Patient Name (ID)",
      `${[patient?.firstName, patient?.lastName].filter(Boolean).join(" ")} (${patientCode})`,
      left,
      detailY + 36,
      colWidth
    );
    addLabelValue(doc, "Mobile Number", patient?.phone || "Not specified", left + colWidth + 18, detailY + 36, colWidth);

    // Row 3
    addLabelValue(
      doc,
      "Age / Gender",
      `${patient?.age ? `${patient.age} yrs` : "N/A"} / ${patient?.gender || "N/A"}`,
      left,
      detailY + 72,
      colWidth
    );
    addLabelValue(doc, "Patient Address", patient?.address || "Not specified", left + colWidth + 18, detailY + 72, colWidth);

    doc.y = detailY + 115;
    addDivider(doc, 4);

    // Doctor details Section
    const docY = doc.y;
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor("#0f172a")
      .text("CONSULTING DOCTOR DETAILS", left, docY, { width: pageWidth });

    const doctorName = [doctor?.firstName, doctor?.lastName].filter(Boolean).join(" ");
    const specStr = [doctor?.specialization, doctor?.department].filter(Boolean).join(" - ");

    addLabelValue(doc, "Doctor Name", `Dr. ${doctorName}`, left, docY + 18, colWidth);
    addLabelValue(doc, "Specialization & Department", specStr || "Not specified", left + colWidth + 18, docY + 18, colWidth);

    doc.y = docY + 58;
    addDivider(doc, 4);

    // Billing details Table
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor("#0f172a")
      .text("BILLING DETAILS", left, doc.y, { width: pageWidth });
    
    doc.moveDown(0.6);

    const tableY = doc.y;
    // Table Headers
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#1e293b");
    doc.text("Description", left + 10, tableY, { width: colWidth });
    doc.text("Qty", left + colWidth + 10, tableY, { width: 40, align: "right" });
    doc.text("Rate (INR)", left + colWidth + 60, tableY, { width: 70, align: "right" });
    doc.text("Amount (INR)", left + colWidth + 140, tableY, { width: 80, align: "right" });

    // Table divider line
    doc.moveTo(left, tableY + 12).lineTo(doc.page.width - doc.page.margins.right, tableY + 12).strokeColor("#cbd5e1").lineWidth(1).stroke();

    // Table Rows
    let currentReceiptY = tableY + 20;
    if (receipt.lineItems && receipt.lineItems.length > 0) {
      receipt.lineItems.forEach((item) => {
        doc.font("Helvetica").fontSize(9).fillColor("#334155");
        doc.text(item.description || "Service Item", left + 10, currentReceiptY, { width: colWidth });
        doc.text("1", left + colWidth + 10, currentReceiptY, { width: 40, align: "right" });
        doc.text(`Rs. ${(item.amount || 0).toFixed(2)}`, left + colWidth + 60, currentReceiptY, { width: 70, align: "right" });
        doc.text(`Rs. ${(item.amount || 0).toFixed(2)}`, left + colWidth + 140, currentReceiptY, { width: 80, align: "right" });
        
        currentReceiptY += 18;
      });
    } else {
      doc.font("Helvetica").fontSize(9).fillColor("#334155");
      doc.text(receipt.consultationType || "Consultation Fee", left + 10, currentReceiptY, { width: colWidth });
      doc.text("1", left + colWidth + 10, currentReceiptY, { width: 40, align: "right" });
      doc.text(`Rs. ${receipt.subtotal.toFixed(2)}`, left + colWidth + 60, currentReceiptY, { width: 70, align: "right" });
      doc.text(`Rs. ${receipt.subtotal.toFixed(2)}`, left + colWidth + 140, currentReceiptY, { width: 80, align: "right" });
      
      currentReceiptY += 18;
    }

    // Row divider
    doc.moveTo(left, currentReceiptY).lineTo(doc.page.width - doc.page.margins.right, currentReceiptY).strokeColor("#cbd5e1").lineWidth(0.5).stroke();

    // Totals Section
    const totalStartY = currentReceiptY + 12;
    const labelX = left + colWidth + 40;
    const valueX = left + colWidth + 140;
    const labelW = 90;
    const valueW = 80;

    let currentY = totalStartY;

    const drawTotalRow = (label, val, isBold = false) => {
      doc
        .font(isBold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(9)
        .fillColor(isBold ? "#0f172a" : "#475569")
        .text(label, labelX, currentY, { width: labelW, align: "right" })
        .text(`Rs. ${val.toFixed(2)}`, valueX, currentY, { width: valueW, align: "right" });
      currentY += 16;
    };

    drawTotalRow("Subtotal", receipt.subtotal);
    if (receipt.discount > 0) {
      drawTotalRow("Discount", -receipt.discount);
    }
    if (receipt.tax > 0) {
      drawTotalRow("Tax/GST (Incl.)", receipt.tax);
    }

    // Divider before final amount
    doc.moveTo(labelX + 20, currentY).lineTo(doc.page.width - doc.page.margins.right, currentY).strokeColor("#cbd5e1").lineWidth(0.5).stroke();
    currentY += 6;

    drawTotalRow("Final Amount", receipt.amount, true);
    drawTotalRow("Paid Amount", receipt.paidAmount);
    
    // Highlight Due Amount if > 0
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(receipt.dueAmount > 0 ? "#b91c1c" : "#0f766e")
      .text("Due Amount", labelX, currentY, { width: labelW, align: "right" })
      .text(`Rs. ${receipt.dueAmount.toFixed(2)}`, valueX, currentY, { width: valueW, align: "right" });

    doc.y = currentY + 36;

    // Footer signature and branding
    const footerY = doc.y;
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#64748b")
      .text(`Receipt generated securely. Date: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`, left, footerY)
      .text("Thank you for choosing us.", left, footerY + 12);

    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#475569")
      .text("Authorized Signature", left + colWidth + 60, footerY + 24, { width: 160, align: "center" });

    doc.moveTo(left + colWidth + 60, footerY + 20).lineTo(doc.page.width - doc.page.margins.right, footerY + 20).strokeColor("#64748b").lineWidth(0.5).stroke();
  });

module.exports = {
  generateReceiptPdfBuffer,
};
