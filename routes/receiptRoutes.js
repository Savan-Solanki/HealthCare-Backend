const express = require("express");
const { body, param, query } = require("express-validator");
const controller = require("../controllers/receiptController");
const { protect, restrictTo } = require("../middleware/auth");
const validate = require("../middleware/validate");

const router = express.Router();

router.use(protect);
router.use(restrictTo("Receptionist", "Doctor", "Hospital Admin", "Super Admin"));

// ─── Receipts ─────────────────────────────────────────────────────────────────
router.route("/")
  .get(controller.getReceipts)
  .post(controller.createReceipt);

router.get("/export", controller.exportReceipts);

// ─── Receipt Templates ────────────────────────────────────────────────────────
router.get(
  "/templates",
  [
    query("search").optional({ values: "falsy" }).trim().isLength({ max: 120 }),
    query("sort").optional().isIn(["recent", "mostUsed", "name"]),
  ],
  validate,
  controller.getReceiptTemplates
);

router.post(
  "/templates",
  [
    body("templateName").trim().notEmpty().withMessage("Template name is required"),
    body("amount").isFloat({ min: 0 }).withMessage("Amount must be a positive number"),
    body("consultationType").optional({ values: "falsy" }).trim(),
    body("description").optional({ values: "falsy" }).trim(),
  ],
  validate,
  controller.createReceiptTemplate
);

router.put(
  "/templates/:id",
  [
    param("id").isMongoId().withMessage("Invalid template id"),
    body("templateName").optional().trim().notEmpty().withMessage("Template name cannot be empty"),
    body("amount").optional().isFloat({ min: 0 }).withMessage("Amount must be a positive number"),
  ],
  validate,
  controller.updateReceiptTemplate
);

router.delete(
  "/templates/:id",
  [param("id").isMongoId().withMessage("Invalid template id")],
  validate,
  controller.deleteReceiptTemplate
);

router.patch(
  "/templates/:id/use",
  [param("id").isMongoId().withMessage("Invalid template id")],
  validate,
  controller.recordReceiptTemplateUse
);

router.route("/:id")
  .get(controller.getReceiptDetails);

router.get("/:id/download", controller.getReceiptDownload);

module.exports = router;
