const { isOriginAllowed } = require("../config/cors");

/**
 * Ensures CORS headers are present on error responses (e.g. Multer 413)
 * so browsers surface the real JSON error instead of a generic CORS failure.
 */
const ensureCorsHeaders = (err, req, res, next) => {
  const origin = req.headers.origin;

  if (origin && isOriginAllowed(origin) && !res.headersSent) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }

  next(err);
};

module.exports = ensureCorsHeaders;
