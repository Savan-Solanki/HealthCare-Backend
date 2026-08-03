const crypto = require("crypto");
const axios = require("axios");
const Transaction = require("../models/Transaction");
const PatientUser = require("../models/PatientUser");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const recordActivity = require("../utils/recordActivity");
const logger = require("../utils/logger");

// ─── Plan Configuration ────────────────────────────────────────────────────────
const PRESCRIPTION_PLANS = {
  "10 Prescriptions": { price: 29, credits: 10 },
  "50 Prescriptions": { price: 129, credits: 50 },
  "100 Prescriptions": { price: 199, credits: 100 },
  "250 Prescriptions": { price: 449, credits: 250 },
  "500 Prescriptions": { price: 599, credits: 500 },
};

const REPORT_PLANS = {
  "10 Reports": { price: 49, credits: 10 },
  "50 Reports": { price: 229, credits: 50 },
  "100 Reports": { price: 400, credits: 100 },
  "250 Reports": { price: 699, credits: 250 },
  "500 Reports": { price: 999, credits: 500 },
};

/**
 * Helper to credit user account atomically and prevent double processing
 */
const creditUserAccount = async ({ orderId, paymentId, status = "completed" }) => {
  // Update transaction status to completed only if it is currently pending
  const transaction = await Transaction.findOneAndUpdate(
    { orderId, status: "pending" },
    { $set: { status, paymentId, purchasedAt: new Date() } },
    { new: true }
  );

  if (!transaction) {
    logger.info(`Transaction ${orderId} already processed or does not exist.`);
    return false;
  }

  // Determine credit amount and field
  let creditsToAdd = 0;
  let updateField = "";

  if (transaction.planType === "prescription") {
    const plan = PRESCRIPTION_PLANS[transaction.planName];
    creditsToAdd = plan ? plan.credits : 0;
    updateField = "prescriptionCredits";
  } else if (transaction.planType === "report") {
    const plan = REPORT_PLANS[transaction.planName];
    creditsToAdd = plan ? plan.credits : 0;
    updateField = "reportCredits";
  }

  if (creditsToAdd <= 0 || !updateField) {
    logger.error(`Invalid plan name or type for transaction: ${transaction.planName}`);
    return false;
  }

  // Atomically increment the credits on PatientUser using database write locking ($inc)
  const updatedUser = await PatientUser.findByIdAndUpdate(
    transaction.userId,
    { $inc: { [updateField]: creditsToAdd } },
    { new: true }
  );

  if (!updatedUser) {
    logger.error(`PatientUser not found during credit allocation: ${transaction.userId}`);
    return false;
  }

  // Log credit addition transaction
  const CreditTransaction = require("../models/CreditTransaction");
  await CreditTransaction.create({
    userId: transaction.userId,
    creditType: transaction.planType,
    type: "addition",
    amount: creditsToAdd,
    reason: "purchase",
    performedBy: "system",
    metadata: { orderId: transaction.orderId, paymentId },
  });

  // Record audit log
  await recordActivity({
    action: "PATIENT_PLAN_PURCHASED",
    entity: "Transaction",
    entityId: transaction._id,
    user: updatedUser,
    description: `Purchased ${transaction.planName} (${creditsToAdd} credits) for ₹${transaction.amount}`,
    meta: {
      orderId,
      paymentId,
      creditsAdded: creditsToAdd,
      creditsField: updateField,
      newBalance: updatedUser[updateField],
    },
  });

  // Emit real-time socket update to the patient
  try {
    const { emitToPatient, EVENTS } = require("../utils/realtimeEvents");
    emitToPatient(updatedUser._id, EVENTS.PROFILE_UPDATED, {
      reportCredits: updatedUser.reportCredits,
      prescriptionCredits: updatedUser.prescriptionCredits,
    });
  } catch (socketErr) {
    logger.error("Failed to emit profile:updated socket event:", socketErr);
  }

  logger.info(`Successfully credited ${creditsToAdd} ${transaction.planType} credits to user ${updatedUser._id}`);
  return true;
};

// ─── Controller Methods ────────────────────────────────────────────────────────

/**
 * POST /payments/create-order
 * Create a new local transaction, and make API call to Razorpay to generate order_id
 */
exports.createOrder = catchAsync(async (req, res, next) => {
  const { planType, planName } = req.body;

  if (!planType || !planName) {
    return next(new AppError("Plan type and plan name are required.", 400));
  }

  // Retrieve plan details
  let planDetails;
  if (planType === "prescription") {
    planDetails = PRESCRIPTION_PLANS[planName];
  } else if (planType === "report") {
    planDetails = REPORT_PLANS[planName];
  }

  if (!planDetails) {
    return next(new AppError("Invalid plan name or type specified.", 400));
  }

  const amountInPaise = planDetails.price * 100;

  // Create pending transaction in DB first
  const transaction = await Transaction.create({
    userId: req.user._id,
    planType,
    planName,
    amount: planDetails.price,
    orderId: `temp_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`, // temporary orderId
    status: "pending",
  });

  // Make REST call to Razorpay to create Order
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    return next(new AppError("Razorpay credentials are not configured on the server.", 500));
  }

  try {
    const response = await axios.post(
      "https://api.razorpay.com/v1/orders",
      {
        amount: amountInPaise,
        currency: "INR",
        receipt: transaction._id.toString(),
      },
      {
        auth: {
          username: keyId,
          password: keySecret,
        },
      }
    );

    const razorpayOrder = response.data;

    // Update transaction with actual Razorpay Order ID
    transaction.orderId = razorpayOrder.id;
    await transaction.save();

    res.status(200).json({
      success: true,
      data: {
        keyId,
        orderId: razorpayOrder.id,
        amount: razorpayOrder.amount,
        currency: razorpayOrder.currency,
        planName,
        planType,
        transactionId: transaction._id,
      },
    });
  } catch (error) {
    // Revert/Delete the pending transaction if order generation fails
    await Transaction.findByIdAndDelete(transaction._id);

    const errorDetails = error.response?.data?.error?.description || error.message;
    logger.error(`Razorpay order creation failed: ${errorDetails}`);
    return next(new AppError(`Payment gateway error: ${errorDetails}`, 502));
  }
});

/**
 * POST /payments/verify-payment
 * Verify signature of Razorpay checkout
 */
exports.verifyPayment = catchAsync(async (req, res, next) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return next(new AppError("Payment details (order_id, payment_id, signature) are required.", 400));
  }

  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) {
    return next(new AppError("Razorpay credentials are not configured on the server.", 500));
  }

  // Local signature verification: HMAC-SHA256 of orderId + "|" + paymentId using secret
  const generatedSignature = crypto
    .createHmac("sha256", keySecret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");

  if (generatedSignature !== razorpay_signature) {
    // Record payment failure audit log
    await Transaction.findOneAndUpdate({ orderId: razorpay_order_id }, { $set: { status: "failed" } });
    return next(new AppError("Payment signature verification failed. Possible fraud attempt.", 400));
  }

  // Perform credit allocation
  const success = await creditUserAccount({
    orderId: razorpay_order_id,
    paymentId: razorpay_payment_id,
    status: "completed",
  });

  res.status(200).json({
    success: true,
    message: success
      ? "Payment verified and account credited successfully."
      : "Payment verified (already processed).",
  });
});

/**
 * POST /payments/webhook
 * Public endpoint to handle webhook events from Razorpay
 */
exports.handleWebhook = catchAsync(async (req, res, next) => {
  const signature = req.headers["x-razorpay-signature"];

  if (!signature) {
    return res.status(400).json({ success: false, message: "Missing webhook signature header" });
  }

  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  // Verify webhook signature (with placeholder fallback bypass for local testing)
  if (webhookSecret && webhookSecret !== "rzp_webhook_secret_placeholder") {
    const expectedSignature = crypto
      .createHmac("sha256", webhookSecret)
      .update(req.rawBody)
      .digest("hex");

    if (expectedSignature !== signature) {
      logger.error("Razorpay webhook signature verification failed.");
      return res.status(400).json({ success: false, message: "Invalid signature" });
    }
  } else {
    logger.warn("Razorpay Webhook secret is not configured or is placeholder. Signature check bypassed.");
  }

  const event = req.body;
  logger.info(`Received Razorpay webhook event: ${event.event}`);

  // We are interested in payment.captured or order.paid
  if (event.event === "order.paid" || event.event === "payment.captured") {
    const paymentEntity = event.payload.payment.entity;
    const orderId = paymentEntity.order_id;
    const paymentId = paymentEntity.id;

    if (orderId) {
      await creditUserAccount({
        orderId,
        paymentId,
        status: "completed",
      });
    }
  }

  res.status(200).json({ success: true });
});

/**
 * GET /payments/history
 * Fetch purchase logs for patient user
 */
exports.getPaymentHistory = catchAsync(async (req, res, next) => {
  const transactions = await Transaction.find({ userId: req.user._id })
    .sort({ purchasedAt: -1, createdAt: -1 })
    .lean();

  res.status(200).json({
    success: true,
    total: transactions.length,
    data: transactions.map((t) => ({
      id: String(t._id),
      planType: t.planType,
      planName: t.planName,
      amount: t.amount,
      paymentId: t.paymentId || "N/A",
      orderId: t.orderId,
      status: t.status,
      purchasedAt: t.purchasedAt,
    })),
  });
});
