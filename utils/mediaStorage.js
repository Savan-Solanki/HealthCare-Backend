const {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const path = require("path");

const AppError = require("./AppError");
const { ensureStorageConfig, getBucketName, getS3Client } = require("./s3Client");
const { trackUpload, trackDelete, inferModuleFromKey } = require("./storageTracker");

const DEFAULT_SIGNED_URL_TTL_SECONDS = 60 * 60;
const UPLOAD_SESSION_TTL_SECONDS = 5 * 60;

const cleanKeySegment = (value, fallback = "unknown") => {
  const source =
    value && typeof value === "object" && value._id
      ? value._id
      : value && typeof value.toHexString === "function"
        ? value.toHexString()
        : value;

  const clean = String(source || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return clean || fallback;
};

const cleanMetadataValue = (value) => {
  const source =
    value && typeof value === "object" && value._id
      ? value._id
      : value && typeof value.toHexString === "function"
        ? value.toHexString()
        : value;

  return String(source || "")
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 512);
};

const getMediaPrefix = () =>
  cleanKeySegment(process.env.AWS_S3_MEDIA_PREFIX || "media", "media");

const extensionFromContentType = (contentType) => {
  const normalized = String(contentType || "").trim().toLowerCase();

  if (normalized.includes("png")) return "png";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("heic") || normalized.includes("heif")) return "heic";
  return "jpg";
};

const buildAvatarObjectKey = ({ patientUserId, extension = "jpg" }) => {
  const ownerSegment = cleanKeySegment(patientUserId, "unknown-patient");
  const extensionSegment = cleanKeySegment(extension, "jpg").replace(/^\./, "");

  return [getMediaPrefix(), "avatars", "patients", ownerSegment, `avatar.${extensionSegment}`].join(
    "/"
  );
};

const buildHospitalLogoObjectKey = ({ hospitalId, extension = "png" }) => {
  const hospitalSegment = cleanKeySegment(hospitalId, "unknown-hospital");
  const extensionSegment = cleanKeySegment(extension, "png").replace(/^\./, "");

  return ["hospital-assets", hospitalSegment, "logo", `logo.${extensionSegment}`].join(
    "/"
  );
};

const buildAdPosterObjectKey = ({ adId, extension = "jpg" }) => {
  const adSegment = cleanKeySegment(adId, "unknown-ad");
  const extensionSegment = cleanKeySegment(extension, "jpg").replace(/^\./, "");

  return [getMediaPrefix(), "ads", adSegment, `poster.${extensionSegment}`].join("/");
};

const getBrandingLogoKey = () =>
  String(process.env.medikwik_LOGO_S3_KEY || `${getMediaPrefix()}/logos/branding/medikwik-logo.png`).trim();

const isStoredMediaKey = (value) => {
  const key = String(value || "").trim();
  if (!key) return false;
  if (/^https?:\/\//i.test(key)) return false;
  if (key.startsWith("data:")) return false;
  return key.includes("/");
};

const uploadMediaObject = async ({
  key,
  body,
  contentType,
  metadata = {},
}) => {
  ensureStorageConfig();

  const serverSideEncryption = String(
    process.env.AWS_S3_SERVER_SIDE_ENCRYPTION || "AES256"
  ).trim();

  const command = new PutObjectCommand({
    Bucket: getBucketName(),
    Key: key,
    Body: body,
    ContentType: contentType,
    Metadata: Object.entries(metadata).reduce((acc, [name, value]) => {
      if (value === undefined || value === null) return acc;
      const cleanValue = cleanMetadataValue(value);
      if (!cleanValue) return acc;
      acc[cleanKeySegment(name)] = cleanValue;
      return acc;
    }, {}),
    ...(serverSideEncryption ? { ServerSideEncryption: serverSideEncryption } : {}),
    ...(process.env.AWS_S3_KMS_KEY_ID
      ? { SSEKMSKeyId: process.env.AWS_S3_KMS_KEY_ID }
      : {}),
  });

  const result = await getS3Client().send(command);

  const uploadResult = {
    bucket: getBucketName(),
    key,
    contentType,
    size: Buffer.isBuffer(body) ? body.length : 0,
    etag: String(result.ETag || "").replace(/^"|"$/g, ""),
    uploadedAt: new Date(),
  };

  // ── Storage tracking (fire-and-forget) ────────────────────────────────────
  void trackUpload({
    bucket: uploadResult.bucket,
    s3Key: key,
    module: inferModuleFromKey(key),
    mimeType: contentType,
    fileSizeBytes: uploadResult.size,
  });

  return uploadResult;
};

const createMediaUploadUrl = async ({
  key,
  contentType,
  expiresIn = UPLOAD_SESSION_TTL_SECONDS,
}) => {
  ensureStorageConfig();

  const command = new PutObjectCommand({
    Bucket: getBucketName(),
    Key: key,
    ContentType: contentType,
  });

  const url = await getSignedUrl(getS3Client(), command, { expiresIn });

  return {
    url,
    key,
    expiresIn,
  };
};

const streamToBuffer = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const getMediaObjectBuffer = async (key) => {
  ensureStorageConfig();

  const result = await getS3Client().send(
    new GetObjectCommand({
      Bucket: getBucketName(),
      Key: key,
    })
  );

  if (!result.Body) {
    throw new AppError("Requested media file was not found in storage.", 404);
  }

  return streamToBuffer(result.Body);
};

const deleteMediaObject = async (key) => {
  ensureStorageConfig();

  await getS3Client().send(
    new DeleteObjectCommand({
      Bucket: getBucketName(),
      Key: key,
    })
  );

  // ── Storage tracking (fire-and-forget) ────────────────────────────────────
  void trackDelete(key);
};

const createMediaDownloadUrl = async ({
  key,
  contentType,
  expiresIn = DEFAULT_SIGNED_URL_TTL_SECONDS,
}) => {
  ensureStorageConfig();

  const command = new GetObjectCommand({
    Bucket: getBucketName(),
    Key: key,
    ...(contentType ? { ResponseContentType: contentType } : {}),
  });

  const url = await getSignedUrl(getS3Client(), command, { expiresIn });

  return {
    url,
    expiresIn,
  };
};

const resolveMediaUrl = async (value, options = {}) => {
  const source = String(value || "").trim();
  if (!source) return null;

  if (/^https?:\/\//i.test(source) || source.startsWith("data:")) {
    return source;
  }

  if (!isStoredMediaKey(source)) {
    return source;
  }

  try {
    const { url } = await createMediaDownloadUrl({
      key: source,
      contentType: options.contentType,
      expiresIn: options.expiresIn,
    });
    return url;
  } catch {
    return null;
  }
};

const resolveStoredMediaDocument = async (document) => {
  if (!document?.key) return null;

  return resolveMediaUrl(document.key, {
    contentType: document.contentType,
  });
};

const getLocalBrandingLogoPath = () =>
  path.join(__dirname, "..", "assets", "medikwik-logo.png");

module.exports = {
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  UPLOAD_SESSION_TTL_SECONDS,
  ALLOWED_IMAGE_MIME_TYPES: ["image/jpeg", "image/png", "image/webp"],
  MAX_AVATAR_UPLOAD_BYTES: 5 * 1024 * 1024,
  MAX_LOGO_UPLOAD_BYTES: 2 * 1024 * 1024,
  buildAvatarObjectKey,
  buildHospitalLogoObjectKey,
  buildAdPosterObjectKey,
  getBrandingLogoKey,
  extensionFromContentType,
  isStoredMediaKey,
  uploadMediaObject,
  createMediaUploadUrl,
  getMediaObjectBuffer,
  deleteMediaObject,
  createMediaDownloadUrl,
  resolveMediaUrl,
  resolveStoredMediaDocument,
  getLocalBrandingLogoPath,
};
