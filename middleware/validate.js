const { validationResult } = require("express-validator");
const AppError = require("../utils/AppError");

/**
 * Middleware to run after express-validator checks.
 * Extracts errors and forwards a 422 AppError if any found.
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const messages = errors
      .array()
      .map((e) => `${e.path}: ${e.msg}`)
      .join(", ");
    return next(new AppError(`Validation error: ${messages}`, 422));
  }
  next();
};

module.exports = validate;
