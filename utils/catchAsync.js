/**
 * Wraps async route handlers to eliminate try/catch boilerplate.
 * @param {Function} fn - Async express handler
 */
const catchAsync = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = catchAsync;
