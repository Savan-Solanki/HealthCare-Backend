const {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const AppError = require("./AppError");
const { trackUpload, trackDelete, STORAGE_MODULES } = require("./storageTracker");

const DEFAULT_SIGNED_URL_TTL_SECONDS = 24 * 60 * 60; // 24 hours link expiry

let s3Client;

const getBucketName = () => String(process.env.AWS_S3_BUCKET || "").trim();
const getRegion = () => String(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "").trim();

const ensureStorageConfig = () => {
  const missing = [];
  if (!getBucketName()) missing.push("AWS_S3_BUCKET");
  if (!getRegion()) missing.push("AWS_REGION");

  if (missing.length) {
    throw new AppError(`Discharge summary storage is not configured: ${missing.join(", ")}`, 500);
  }
};

const getClient = () => {
  ensureStorageConfig();

  if (!s3Client) {
    const credentials =
      process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          }
        : undefined;

    s3Client = new S3Client({
      region: getRegion(),
      credentials,
    });
  }

  return s3Client;
};

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

const buildDischargeSummaryObjectKey = ({ hospitalId, patientOwnerId, dischargeSummaryId, extension = "pdf" }) => {
  const hospitalSegment = hospitalId ? `hospitals/${cleanKeySegment(hospitalId)}` : "patient-uploads";
  const patientSegment = cleanKeySegment(patientOwnerId, "unlinked-patient");
  const idSegment = cleanKeySegment(dischargeSummaryId);
  const ext = cleanKeySegment(extension, "pdf").replace(/^\./, "");

  return `discharge-summaries/${hospitalSegment}/patients/${patientSegment}/${idSegment}.${ext}`;
};

const buildContentDisposition = (fileName) => {
  const safeName = String(fileName || "discharge_summary.pdf")
    .replace(/["\\]/g, "")
    .replace(/[\r\n]/g, "")
    .trim();

  return `attachment; filename="${safeName}"`;
};

const uploadDischargeSummaryObject = async ({
  hospitalId,
  patientOwnerId,
  dischargeSummaryId,
  body,
  fileName,
  contentType = "application/pdf",
}) => {
  ensureStorageConfig();

  const key = buildDischargeSummaryObjectKey({ hospitalId, patientOwnerId, dischargeSummaryId });
  const serverSideEncryption = String(process.env.AWS_S3_SERVER_SIDE_ENCRYPTION || "AES256").trim();

  const command = new PutObjectCommand({
    Bucket: getBucketName(),
    Key: key,
    Body: body,
    ContentType: contentType,
    ContentDisposition: buildContentDisposition(fileName),
    ...(serverSideEncryption ? { ServerSideEncryption: serverSideEncryption } : {}),
  });

  await getClient().send(command);

  const uploadResult = {
    bucket: getBucketName(),
    key,
    contentType,
    fileName,
    size: body.length,
    generatedAt: new Date(),
  };

  // ── Storage tracking (fire-and-forget) ────────────────────────────────────
  void trackUpload({
    hospitalId,
    bucket: uploadResult.bucket,
    s3Key: key,
    originalName: fileName,
    fileName,
    module: STORAGE_MODULES.DISCHARGE_SUMMARY,
    mimeType: contentType,
    fileSizeBytes: uploadResult.size,
  });

  return uploadResult;
};

const createDischargeSummaryDownloadUrl = async ({ key, fileName, contentType = "application/pdf", expiresIn = DEFAULT_SIGNED_URL_TTL_SECONDS }) => {
  ensureStorageConfig();

  const command = new GetObjectCommand({
    Bucket: getBucketName(),
    Key: key,
    ResponseContentDisposition: buildContentDisposition(fileName),
    ResponseContentType: contentType,
  });

  const url = await getSignedUrl(getClient(), command, { expiresIn });

  return {
    url,
    expiresIn,
  };
};

const deleteDischargeSummaryObject = async (key) => {
  ensureStorageConfig();

  await getClient().send(
    new DeleteObjectCommand({
      Bucket: getBucketName(),
      Key: key,
    })
  );

  // ── Storage tracking (fire-and-forget) ────────────────────────────────────
  void trackDelete(key);
};

module.exports = {
  uploadDischargeSummaryObject,
  createDischargeSummaryDownloadUrl,
  deleteDischargeSummaryObject,
};
