const multer = require("multer");

const AppError = require("../utils/AppError");

const MAX_PRESCRIPTION_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_PRESCRIPTION_UPLOAD_MB = 20;
const ALLOWED_PRESCRIPTION_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
];

const allowedMimeTypes = new Set([
  ...ALLOWED_PRESCRIPTION_MIME_TYPES,
]);

const prescriptionUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_PRESCRIPTION_UPLOAD_BYTES,
    files: 1,
    fieldSize: 2 * 1024 * 1024,
    fields: 12,
  },
  fileFilter: (req, file, callback) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      return callback(
        new AppError("Upload a JPG, PNG, WEBP, HEIC, or PDF prescription file.", 400)
      );
    }

    callback(null, true);
  },
});

module.exports = {
  ALLOWED_PRESCRIPTION_MIME_TYPES,
  MAX_PRESCRIPTION_UPLOAD_BYTES,
  MAX_PRESCRIPTION_UPLOAD_MB,
  prescriptionUpload,
};
