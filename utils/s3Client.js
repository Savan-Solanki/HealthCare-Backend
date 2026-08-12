const { S3Client, PutBucketCorsCommand } = require("@aws-sdk/client-s3");

const AppError = require("./AppError");

let s3Client;

const getBucketName = () => String(process.env.AWS_S3_BUCKET || "").trim();

const getRegion = () =>
  String(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "").trim();

const ensureStorageConfig = () => {
  const missing = [];
  if (!getBucketName()) missing.push("AWS_S3_BUCKET");
  if (!getRegion()) missing.push("AWS_REGION");

  if (missing.length) {
    throw new AppError(`Object storage is not configured: ${missing.join(", ")}`, 500);
  }
};

const getS3Client = () => {
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

const ensureBucketCors = async () => {
  try {
    const client = getS3Client();
    const bucket = getBucketName();
    const command = new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedHeaders: ["*"],
            AllowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"],
            AllowedOrigins: [
              "https://health-care-mobile.vercel.app",
              "https://health-care-web-phi.vercel.app",
              "http://localhost:3000",
              "http://localhost:3001",
              "*",
            ],
            ExposeHeaders: ["ETag"],
            MaxAgeSeconds: 3000,
          },
        ],
      },
    });
    await client.send(command);
  } catch {
    // Non-fatal if AWS credentials lack s3:PutBucketCORS permission
  }
};

module.exports = {
  ensureStorageConfig,
  ensureBucketCors,
  getBucketName,
  getRegion,
  getS3Client,
};
