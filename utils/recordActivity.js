const Activity = require("../models/Activity");
const logger = require("./logger");

/**
 * Records a user/system activity event to the database.
 * Fire-and-forget — does not block the response.
 *
 * @param {Object} params
 * @param {string} params.action    - Short action key e.g. "USER_CREATED"
 * @param {string} params.entity    - Model name e.g. "User", "Hospital"
 * @param {*}      [params.entityId]  - Related document ObjectId
 * @param {Object} [params.user]    - Authenticated user object
 * @param {string} [params.description] - Human-readable description
 * @param {string} [params.ip]      - Request IP
 * @param {Object} [params.meta]    - Extra metadata
 */
const recordActivity = async ({
  action,
  entity,
  entityId = null,
  user = null,
  description = "",
  ip = null,
  meta = {},
}) => {
  try {
    await Activity.create({
      action,
      entity,
      entityId,
      userId: user?._id || null,
      userName: user?.name || "System",
      userRole: user?.role || null,
      description,
      ip,
      meta,
    });
  } catch (err) {
    // Non-blocking: log the failure without crashing
    logger.error(`Failed to record activity [${action}]: ${err.message}`);
  }
};

module.exports = recordActivity;
