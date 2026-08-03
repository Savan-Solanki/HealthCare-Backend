const logger = require("../utils/logger");
const AppError = require("../utils/AppError");
const mongoose = require("mongoose");

// ─── Handle specific Mongoose/JWT errors ───────────────────────────────────────
const handleCastErrorDB = (err) =>
  new AppError(`Invalid ${err.path}: ${err.value}.`, 400);

const handleDuplicateFieldsDB = (err) => {
  const keys = Object.keys(err.keyValue || {}).join(", ");
  const values = Object.values(err.keyValue || {}).join(", ");
  const value = err.errmsg?.match(/(["'])(\\?.)*?\1/)?.[0] || (values ? `'${values}'` : "unknown");
  const fieldMsg = keys ? ` for field(s): ${keys}` : "";
  return new AppError(`Duplicate field value: ${value}${fieldMsg}. Please use another value.`, 409);
};

const handleValidationErrorDB = (err) => {
  const errors = Object.values(err.errors).map((el) => el.message);
  return new AppError(`Invalid input data: ${errors.join(". ")}`, 400);
};

const handleJWTError = () =>
  new AppError("Invalid token. Please log in again.", 401);

const handleJWTExpiredError = () =>
  new AppError("Your token has expired. Please log in again.", 401);

const { MAX_PRESCRIPTION_UPLOAD_MB } = require("./prescriptionUpload");

const handleMulterError = (err) => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return new AppError(
      `Prescription photo must be ${MAX_PRESCRIPTION_UPLOAD_MB} MB or smaller.`,
      413
    );
  }

  if (err.code === "LIMIT_UNEXPECTED_FILE") {
    return new AppError('Upload field must be named "prescription".', 400);
  }

  if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_FIELD_COUNT") {
    return new AppError("Only one prescription file can be uploaded at a time.", 400);
  }

  if (err instanceof AppError) {
    return err;
  }

  return new AppError(err.message || "Invalid prescription upload.", 400);
};

const handlePayloadTooLarge = (err) => {
  if (err.type === "entity.too.large") {
    return new AppError(
      `Request payload is too large. Prescription uploads must be ${MAX_PRESCRIPTION_UPLOAD_MB} MB or smaller.`,
      413
    );
  }

  return err;
};

// ─── Dev vs Prod error responses ──────────────────────────────────────────────
const sendErrorDev = (err, res) => {
  res.status(err.statusCode).json({
    success: false,
    status: err.status,
    message: err.message,
    stack: err.stack,
    error: err,
  });
};

const sendErrorProd = (err, res) => {
  // Operational, trusted error — safe to expose
  if (err.isOperational) {
    return res.status(err.statusCode).json({
      success: false,
      status: err.status,
      message: err.message,
    });
  }
  // Programming or unknown error — don't leak details
  logger.error("UNHANDLED ERROR:", err);
  return res.status(500).json({
    success: false,
    status: "error",
    message: "Something went very wrong. Please try again later.",
  });
};

// ─── Global Error Handler Middleware ──────────────────────────────────────────
const errorHandler = (err, req, res, next) => {
  if (err.name === "MulterError" || err.code?.startsWith?.("LIMIT_")) {
    err = handleMulterError(err);
  }

  err = handlePayloadTooLarge(err);

  if (err.message?.startsWith?.("CORS:")) {
    err = new AppError(err.message, 403);
  }

  err.statusCode = err.statusCode || 500;
  err.status = err.status || "error";

  logger.error(`${err.statusCode} - ${err.message} - ${req.originalUrl} - ${req.method} - ${req.ip}`);

  if (process.env.NODE_ENV === "development") {
    return sendErrorDev(err, res);
  }

  // Production: transform known error types
  let error = Object.assign(Object.create(Object.getPrototypeOf(err)), err);
  error.message = err.message;

  if (error.name === "CastError") error = handleCastErrorDB(error);
  if (error.code === 11000) error = handleDuplicateFieldsDB(error);
  if (error.name === "ValidationError") error = handleValidationErrorDB(error);
  if (error.name === "JsonWebTokenError") error = handleJWTError();
  if (error.name === "TokenExpiredError") error = handleJWTExpiredError();
  sendErrorProd(error, res);
};

module.exports = errorHandler;
