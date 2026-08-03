const {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const AppError = require("./AppError");
const { trackUpload, trackDelete, STORAGE_MODULES } = require("./storageTracker");

const DEFAULT_SIGNED_URL_TTL_SECONDS = 5 * 60;

let s3Client;

const getBucketName = () => String(process.env.AWS_S3_BUCKET || "").trim();

const getRegion = () =>
  String(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "").trim();

const ensureStorageConfig = () => {
  const missing = [];
  if (!getBucketName()) missing.push("AWS_S3_BUCKET");
  if (!getRegion()) missing.push("AWS_REGION");

  if (missing.length) {
    throw new AppError(`Prescription storage is not configured: ${missing.join(", ")}`, 500);
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

const getPrescriptionPrefix = () =>
  cleanKeySegment(process.env.AWS_S3_PRESCRIPTION_PREFIX || "prescriptions", "prescriptions");

const buildPrescriptionObjectKey = ({
  hospitalId,
  patientOwnerId,
  prescriptionId,
  source,
  extension = "pdf",
}) => {
  const hospitalSegment = hospitalId ? `hospitals/${cleanKeySegment(hospitalId)}` : "patient-uploads";
  const patientSegment = cleanKeySegment(patientOwnerId, "unlinked-patient");
  const sourceSegment = cleanKeySegment(source || "document");
  const prescriptionSegment = cleanKeySegment(prescriptionId);
  const extensionSegment = cleanKeySegment(extension, "pdf").replace(/^\./, "");

  return [
    getPrescriptionPrefix(),
    hospitalSegment,
    "patients",
    patientSegment,
    sourceSegment,
    `${prescriptionSegment}.${extensionSegment}`,
  ].join("/");
};

const buildContentDisposition = (fileName) => {
  const safeName = String(fileName || "prescription.pdf")
    .replace(/["\\]/g, "")
    .replace(/[\r\n]/g, "")
    .trim();

  return `attachment; filename="${safeName || "prescription.pdf"}"`;
};

const uploadPrescriptionObject = async ({
  key,
  body,
  contentType = "application/pdf",
  fileName,
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
    ContentDisposition: buildContentDisposition(fileName),
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

  const result = await getClient().send(command);

  const uploadResult = {
    bucket: getBucketName(),
    key,
    contentType,
    fileName,
    size: Buffer.isBuffer(body) ? body.length : 0,
    etag: String(result.ETag || "").replace(/^"|"$/g, ""),
    generatedAt: new Date(),
  };

  // ── Storage tracking (fire-and-forget) ────────────────────────────────────
  void trackUpload({
    bucket: uploadResult.bucket,
    s3Key: key,
    originalName: fileName,
    fileName,
    module: contentType && contentType !== "application/pdf"
      ? STORAGE_MODULES.PRESCRIPTION_IMAGE
      : STORAGE_MODULES.PRESCRIPTION_PDF,
    mimeType: contentType,
    fileSizeBytes: uploadResult.size,
  });

  return uploadResult;
};

const streamToBuffer = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const createPrescriptionUploadUrl = async ({
  key,
  contentType,
  expiresIn = DEFAULT_SIGNED_URL_TTL_SECONDS,
}) => {
  ensureStorageConfig();

  const command = new PutObjectCommand({
    Bucket: getBucketName(),
    Key: key,
    ContentType: contentType,
  });

  const url = await getSignedUrl(getClient(), command, { expiresIn });

  return {
    url,
    key,
    expiresIn,
  };
};

const getPrescriptionObjectBuffer = async (key) => {
  ensureStorageConfig();

  const result = await getClient().send(
    new GetObjectCommand({
      Bucket: getBucketName(),
      Key: key,
    })
  );

  if (!result.Body) {
    throw new AppError("Uploaded prescription file was not found in storage.", 404);
  }

  return streamToBuffer(result.Body);
};

const deletePrescriptionObject = async (key) => {
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

const createPrescriptionDownloadUrl = async ({
  key,
  fileName,
  contentType = "application/pdf",
  expiresIn = DEFAULT_SIGNED_URL_TTL_SECONDS,
}) => {
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

module.exports = {
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  buildPrescriptionObjectKey,
  createPrescriptionDownloadUrl,
  createPrescriptionUploadUrl,
  deletePrescriptionObject,
  getPrescriptionObjectBuffer,
  uploadPrescriptionObject,
};
