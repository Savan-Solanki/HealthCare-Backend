/**
 * CSV Export Utility
 * Pure JS implementation — no external dependency required.
 */

/**
 * Escapes a cell value for safe CSV output.
 */
const escapeCell = (val) => {
  if (val === null || val === undefined) return "";
  const str = String(val);
  // Wrap in quotes if contains comma, newline, or quote
  if (str.includes(",") || str.includes("\n") || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

/**
 * Converts an array of objects to a CSV string.
 * @param {Array<Object>} data   - Array of flat objects
 * @param {Array<string>} fields - Column header names (must match object keys)
 * @returns {string} CSV string
 */
const generateCSV = (data, fields) => {
  const header = fields.map(escapeCell).join(",");
  const rows = data.map((row) =>
    fields.map((f) => escapeCell(row[f])).join(",")
  );
  return [header, ...rows].join("\r\n");
};

/**
 * Sends a CSV download response.
 * @param {import('express').Response} res
 * @param {Array<Object>} data
 * @param {Array<string>} fields
 * @param {string} [filename]
 */
const sendCSV = (res, data, fields, filename = "export") => {
  const csv = generateCSV(data, fields);
  const timestamp = new Date().toISOString().split("T")[0];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}-${timestamp}.csv"`
  );
  // BOM for Excel UTF-8 compatibility
  res.status(200).send("\uFEFF" + csv);
};

module.exports = { generateCSV, sendCSV };
