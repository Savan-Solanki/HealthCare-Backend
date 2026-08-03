const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const PlatformAd = require("../models/PlatformAd");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_LOGO_UPLOAD_BYTES,
  UPLOAD_SESSION_TTL_SECONDS,
  buildAdPosterObjectKey,
  createMediaUploadUrl,
  deleteMediaObject,
  extensionFromContentType,
  getMediaObjectBuffer,
  resolveStoredMediaDocument,
} = require("../utils/mediaStorage");
const recordActivity = require("../utils/recordActivity");

const AD_UPLOAD_SESSION_PURPOSE = "platform-ad-upload";

const buildAdPosterKey = ({ adId, extension = "jpg" }) =>
  buildAdPosterObjectKey({ adId, extension });

const mapAdResponse = async (ad) => {
  const adObject = ad.toObject ? ad.toObject() : ad;
  const posterUrl = await resolveStoredMediaDocument(adObject.poster);

  return {
    id: String(adObject._id),
    title: adObject.title || "",
    businessLink: adObject.businessLink,
    posterUrl,
    durationDays: adObject.durationDays,
    startsAt: adObject.startsAt,
    expiresAt: adObject.expiresAt,
    targetAudience: adObject.targetAudience,
    isActive: adObject.isActive,
    createdAt: adObject.createdAt,
    updatedAt: adObject.updatedAt,
  };
};

const normalizeBusinessLink = (value) => {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    throw new AppError("Business link is required.", 400);
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const parsed = new URL(withProtocol);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("invalid protocol");
    }
    return parsed.toString();
  } catch {
    throw new AppError("Business link must be a valid URL.", 400);
  }
};

exports.getActiveAds = catchAsync(async (req, res) => {
  const audience = req.query.audience === "patient" ? "patient" : "staff";
  const now = new Date();

  const ads = await PlatformAd.find({
    isActive: true,
    expiresAt: { $gt: now },
    $or: [{ targetAudience: "all" }, { targetAudience: audience }],
  })
    .sort({ createdAt: -1 })
    .limit(3);

  const data = await Promise.all(ads.map(mapAdResponse));

  res.status(200).json({
    success: true,
    data,
  });
});

exports.getAllAds = catchAsync(async (req, res) => {
  const ads = await PlatformAd.find().sort({ createdAt: -1 }).limit(100);
  const data = await Promise.all(ads.map(mapAdResponse));

  res.status(200).json({
    success: true,
    total: data.length,
    data,
  });
});

exports.createAdUploadSession = catchAsync(async (req, res, next) => {
  const contentType = String(req.body.contentType || "").trim().toLowerCase();
  const fileSize = Number(req.body.fileSize);

  if (!ALLOWED_IMAGE_MIME_TYPES.includes(contentType)) {
    return next(new AppError("Upload a JPG, PNG, or WEBP ad poster.", 400));
  }

  if (!Number.isFinite(fileSize) || fileSize < 1 || fileSize > MAX_LOGO_UPLOAD_BYTES) {
    return next(
      new AppError(`Ad poster must be ${MAX_LOGO_UPLOAD_BYTES / (1024 * 1024)} MB or smaller.`, 400)
    );
  }

  const adId = new mongoose.Types.ObjectId();
  const objectKey = buildAdPosterKey({
    adId,
    extension: extensionFromContentType(contentType),
  });

  const { url, expiresIn } = await createMediaUploadUrl({
    key: objectKey,
    contentType,
    expiresIn: UPLOAD_SESSION_TTL_SECONDS,
  });

  const uploadToken = jwt.sign(
    {
      purpose: AD_UPLOAD_SESSION_PURPOSE,
      adId: adId.toString(),
      objectKey,
      contentType,
      fileSize,
      uploadedBy: req.user._id.toString(),
    },
    process.env.JWT_SECRET,
    { expiresIn: UPLOAD_SESSION_TTL_SECONDS }
  );

  res.status(200).json({
    success: true,
    message: "Ad poster upload session created.",
    data: {
      uploadUrl: url,
      uploadToken,
      expiresIn,
      contentType,
    },
  });
});

exports.createAd = catchAsync(async (req, res, next) => {
  const title = String(req.body.title || "").trim();
  const businessLink = normalizeBusinessLink(req.body.businessLink);
  const durationDays = Number(req.body.durationDays);
  const targetAudience = req.body.targetAudience || "all";
  const uploadToken = String(req.body.uploadToken || "").trim();

  if (!Number.isFinite(durationDays) || durationDays < 1 || durationDays > 365) {
    return next(new AppError("Ad duration must be between 1 and 365 days.", 400));
  }

  if (!["all", "patient", "staff"].includes(targetAudience)) {
    return next(new AppError("Invalid ad audience.", 400));
  }

  if (!uploadToken) {
    return next(new AppError("Upload the ad poster before publishing.", 400));
  }

  let decoded;
  try {
    decoded = jwt.verify(uploadToken, process.env.JWT_SECRET);
  } catch {
    return next(new AppError("Upload session expired. Please try again.", 400));
  }

  if (decoded.purpose !== AD_UPLOAD_SESSION_PURPOSE) {
    return next(new AppError("Upload session is invalid. Please try again.", 400));
  }

  let imageBuffer;
  try {
    imageBuffer = await getMediaObjectBuffer(decoded.objectKey);
  } catch {
    return next(new AppError("Upload the ad poster before publishing.", 400));
  }

  const startsAt = new Date();
  const expiresAt = new Date(startsAt);
  expiresAt.setDate(expiresAt.getDate() + durationDays);

  const ad = await PlatformAd.create({
    _id: decoded.adId,
    title,
    businessLink,
    durationDays,
    startsAt,
    expiresAt,
    targetAudience,
    isActive: true,
    createdBy: req.user._id,
    poster: {
      bucket: process.env.AWS_S3_BUCKET,
      key: decoded.objectKey,
      contentType: decoded.contentType,
      size: imageBuffer.length,
      uploadedAt: new Date(),
    },
  });

  await recordActivity({
    action: "PLATFORM_AD_CREATED",
    entity: "PlatformAd",
    entityId: ad._id,
    user: req.user,
    description: `Platform ad created (${targetAudience}) until ${expiresAt.toISOString()}`,
    ip: req.ip,
  });

  res.status(201).json({
    success: true,
    message: "Advertisement published successfully.",
    data: await mapAdResponse(ad),
  });
});

exports.deleteAd = catchAsync(async (req, res, next) => {
  const ad = await PlatformAd.findById(req.params.id);
  if (!ad) return next(new AppError("Advertisement not found.", 404));

  if (ad.poster?.key) {
    try {
      await deleteMediaObject(ad.poster.key);
    } catch {
      // Ignore cleanup failures.
    }
  }

  await PlatformAd.findByIdAndDelete(ad._id);

  await recordActivity({
    action: "PLATFORM_AD_DELETED",
    entity: "PlatformAd",
    entityId: ad._id,
    user: req.user,
    description: "Platform ad removed by super admin.",
    ip: req.ip,
  });

  res.status(200).json({
    success: true,
    message: "Advertisement removed successfully.",
  });
});
