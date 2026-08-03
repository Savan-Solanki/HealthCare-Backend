/**
 * Pagination helper — returns skip, limit, sort, and
 * a standard meta object to include in list responses.
 *
 * @param {import('express').Request} req
 * @param {Object} [defaults]
 * @param {number} [defaults.limit=20]
 * @param {string} [defaults.sortBy="createdAt"]
 * @returns {{ skip, limit, sort, meta }}
 */
const paginate = (req, { limit: defaultLimit = 20, sortBy: defaultSort = "createdAt" } = {}) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || defaultLimit));
  const skip = (page - 1) * limit;
  const sortField = req.query.sortBy || defaultSort;
  const sortDir = req.query.sortOrder === "asc" ? 1 : -1;

  return {
    skip,
    limit,
    sort: { [sortField]: sortDir },
    /**
     * Build meta object once you know `total`.
     * @param {number} total
     */
    meta: (total) => ({
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      hasNextPage: page < Math.ceil(total / limit),
      hasPrevPage: page > 1,
    }),
  };
};

module.exports = { paginate };
