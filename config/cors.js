const logger = require("../utils/logger");

const DEFAULT_ALLOWED_ORIGINS = [
 "https://health-care-web-phi.vercel.app",
 "health-care-web-phi.vercel.app",
 
];

const parseOriginList = (value) =>
  String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const getAllowedOrigins = () =>
  Array.from(
    new Set([
      ...DEFAULT_ALLOWED_ORIGINS,
      ...parseOriginList(process.env.CLIENT_URL),
      ...parseOriginList(process.env.ADDITIONAL_CLIENT_URLS),
    ])
  );

const isOriginAllowed = (origin) => {
  if (!origin) return true;
  if (getAllowedOrigins().includes(origin)) return true;

  // Allow local network IP address ranges (e.g. http://192.168.x.x:3000) for cross-device development
  try {
    const url = new URL(origin);
    const hostname = url.hostname;
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("10.") ||
      (hostname.startsWith("172.") && /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname))
    ) {
      return true;
    }
  } catch (err) {
    // Ignore invalid URLs
  }

  return false;
};

const corsOptions = {
  origin(origin, callback) {
    if (isOriginAllowed(origin)) {
      return callback(null, true);
    }

    logger.warn(`Blocked CORS origin: ${origin}`);
    return callback(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Auth-Portal",
    "Accept",
    // Cache-busting headers sent by the axios interceptor
    "Cache-Control",
    "Pragma",
    "Expires",
    // Device fingerprinting headers for session management
    "x-device-id",
    "x-device-name",
    "x-device-type",
    "x-browser-version",
  ],
  exposedHeaders: ["Content-Disposition"],
  optionsSuccessStatus: 204,
};

module.exports = {
  DEFAULT_ALLOWED_ORIGINS,
  corsOptions,
  getAllowedOrigins,
  isOriginAllowed,
};
