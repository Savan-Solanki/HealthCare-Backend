const express = require("express");
const { body, param, query } = require("express-validator");

const adController = require("../controllers/adController");
const { protect, restrictTo } = require("../middleware/auth");
const validate = require("../middleware/validate");

const router = express.Router();

router.get(
  "/active",
  protect,
  [
    query("audience")
      .optional()
      .isIn(["patient", "staff"])
      .withMessage("Audience must be patient or staff."),
  ],
  validate,
  (req, res, next) => {
    req.query.audience = "staff";
    return adController.getActiveAds(req, res, next);
  }
);

router.use(protect);
router.use(restrictTo("Super Admin"));

router.get("/", adController.getAllAds);
router.post(
  "/upload-session",
  [
    body("contentType")
      .trim()
      .isIn(["image/jpeg", "image/png", "image/webp"])
      .withMessage("Upload a JPG, PNG, or WEBP ad poster."),
    body("fileSize")
      .isInt({ min: 1, max: 2 * 1024 * 1024 })
      .withMessage("Ad poster exceeds the upload size limit."),
  ],
  validate,
  adController.createAdUploadSession
);
router.post(
  "/",
  [
    body("title").optional({ values: "falsy" }).trim().isLength({ max: 120 }),
    body("businessLink").trim().notEmpty().withMessage("Business link is required."),
    body("durationDays")
      .isInt({ min: 1, max: 365 })
      .withMessage("Ad duration must be between 1 and 365 days."),
    body("targetAudience")
      .optional()
      .isIn(["all", "patient", "staff"])
      .withMessage("Invalid ad audience."),
    body("uploadToken").trim().notEmpty().withMessage("Upload session expired. Please try again."),
  ],
  validate,
  adController.createAd
);
router.delete(
  "/:id",
  [param("id").isMongoId().withMessage("Invalid advertisement id.")],
  validate,
  adController.deleteAd
);

module.exports = router;
