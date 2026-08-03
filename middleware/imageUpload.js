const multer = require("multer");
const AppError = require("../utils/AppError");
const { ALLOWED_IMAGE_MIME_TYPES } = require("../utils/mediaStorage");

const createImageUpload = (maxBytes) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes },
    fileFilter: (_req, file, callback) => {
      if (!ALLOWED_IMAGE_MIME_TYPES.includes(String(file.mimetype || "").toLowerCase())) {
        return callback(
          new AppError("Upload a JPG, PNG, or WEBP image.", 400),
          false
        );
      }

      callback(null, true);
    },
  });

module.exports = {
  createImageUpload,
};
