const AppError = require("./AppError");

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const verifyTurnstile = async ({ token, ip }) => {
  const secret = process.env.TURNSTILE_SECRET_KEY;

  if (!secret) {
    throw new AppError("Turnstile secret key is not configured.", 500);
  }

  if (!token) {
    throw new AppError("Captcha verification is required.", 400);
  }

  // Allow dev bypass in development/testing mode when Cloudflare Turnstile key is restricted to production domains
  if (process.env.NODE_ENV !== "production" && (token.startsWith("dev_bypass") || token === "1x00000000000000000000AA")) {
    return { success: true, challenge_ts: new Date().toISOString(), hostname: "localhost" };
  }

  const payload = new URLSearchParams({
    secret,
    response: token,
  });

  if (ip) {
    payload.append("remoteip", ip);
  }

  const response = await fetch(TURNSTILE_VERIFY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: payload.toString(),
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new AppError("Captcha verification could not be completed.", 502);
  }

  const result = await response.json();

  if (!result.success) {
    throw new AppError("Captcha verification failed. Please try again.", 400);
  }

  return result;
};

module.exports = verifyTurnstile;
