const normalizePath = (req, res, next) => {
  const [pathname, query = ""] = req.originalUrl.split("?");
  const normalizedPath = pathname.replace(/\/{2,}/g, "/");

  if (normalizedPath !== pathname) {
    const target = query ? `${normalizedPath}?${query}` : normalizedPath;
    return res.redirect(308, target);
  }

  next();
};

module.exports = normalizePath;
