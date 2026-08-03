const express = require("express");
const router = express.Router();
const fileController = require("../controllers/fileController");
const { protectAny } = require("../middleware/auth");

router.use(protectAny);

// GET /api/v1/files/:id/download
router.get("/:id/download", fileController.downloadFile);

module.exports = router;
