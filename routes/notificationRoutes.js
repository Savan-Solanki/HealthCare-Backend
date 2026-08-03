const express = require("express");
const { body, param } = require("express-validator");

const controller = require("../controllers/notificationController");
const { protect, restrictTo, protectPatient } = require("../middleware/auth");
const validate = require("../middleware/validate");

const router = express.Router();

router.get("/stream", controller.streamNotifications);

router.post(
  "/fcm-token",
  protectPatient,
  [
    body("fcmToken").notEmpty().withMessage("FCM token is required")
  ],
  validate,
  controller.registerFcmToken
);

router.post(
  "/send-test",
  protectPatient,
  controller.sendTestNotification
);

router.use(protect);
router.use(restrictTo("Hospital Admin", "Doctor", "Receptionist"));

router.get("/", controller.getNotifications);
router.delete(
  "/appointment/:appointmentId",
  [param("appointmentId").isMongoId().withMessage("Invalid appointment id")],
  validate,
  controller.dismissAppointmentNotifications
);
router.delete(
  "/:id",
  [param("id").isMongoId().withMessage("Invalid notification id")],
  validate,
  controller.dismissNotification
);

module.exports = router;
