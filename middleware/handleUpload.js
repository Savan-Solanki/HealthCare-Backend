const handleSingleUpload = (uploadMiddleware) => (req, res, next) => {
  uploadMiddleware(req, res, (err) => {
    if (err) {
      return next(err);
    }
    next();
  });
};

module.exports = { handleSingleUpload };
