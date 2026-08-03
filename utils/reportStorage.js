const {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const AppError = require("./AppError");

const DEFAULT_SIGNED_URL_TTL_SECONDS = 15 * 60; // 15 minutes for uploads/downloads

let s3Client;

const getBucketName = () => String(process.env.AWS_S3_BUCKET || "").trim();

const getRegion = () =>
  String(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "ap-south-1").trim();

const ensureStorageConfig = () => {
  const missing = [];
  if (!getBucketName()) missing.push("AWS_S3_BUCKET");
  if (!getRegion()) missing.push("AWS_REGION");

  if (missing.length) {
    throw new AppError(`Report storage is not configured: ${missing.join(", ")}`, 500);
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

/**
 * Builds the S3 key for a report.
 * Folder format: reports/{patientId}/{reportId}-{fileName}
 */
const buildReportObjectKey = ({ patientUserId, reportId, fileName }) => {
  const patientSegment = cleanKeySegment(patientUserId, "unlinked-patient");
  const reportSegment = cleanKeySegment(reportId);
  const cleanFileName = String(fileName || "report.dat")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-");

  return `reports/${patientSegment}/${reportSegment}-${cleanFileName}`;
};

const buildContentDisposition = (fileName) => {
  const safeName = String(fileName || "report.pdf")
    .replace(/["\\]/g, "")
    .replace(/[\r\n]/g, "")
    .trim();

  return `attachment; filename="${safeName}"`;
};

/**
 * Generates a signed PUT URL for direct-to-S3 client side upload
 */
const createReportUploadUrl = async ({ key, contentType, fileSize, expiresIn = DEFAULT_SIGNED_URL_TTL_SECONDS }) => {
  ensureStorageConfig();

  const client = getClient();
  const command = new PutObjectCommand({
    Bucket: getBucketName(),
    Key: key,
    ContentType: contentType,
    ContentLength: fileSize,
  });

  const url = await getSignedUrl(client, command, { expiresIn });

  return {
    url,
    key,
    expiresIn,
  };
};

/**
 * Checks if a report object exists in S3 and returns its metadata/size
 */
const getReportObjectMetadata = async (key) => {
  ensureStorageConfig();

  try {
    const command = new HeadObjectCommand({
      Bucket: getBucketName(),
      Key: key,
    });

    const result = await getClient().send(command);
    return {
      size: result.ContentLength,
      contentType: result.ContentType,
      etag: String(result.ETag || "").replace(/^"|"$/g, ""),
    };
  } catch (err) {
    if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
      throw new AppError("File was not found in storage. Please upload the file first.", 404);
    }
    throw new AppError(`S3 check failed: ${err.message}`, 500);
  }
};

/**
 * Deletes a report file from S3
 */
const deleteReportObject = async (key) => {
  ensureStorageConfig();

  const command = new DeleteObjectCommand({
    Bucket: getBucketName(),
    Key: key,
  });

  await getClient().send(command);
};

/**
 * Generates a signed GET URL for downloading/viewing a report
 */
const createReportDownloadUrl = async ({ key, fileName, contentType, expiresIn = DEFAULT_SIGNED_URL_TTL_SECONDS }) => {
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
  buildReportObjectKey,
  createReportUploadUrl,
  getReportObjectMetadata,
  deleteReportObject,
  createReportDownloadUrl,
};
