const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.AWS_S3_BUCKET || 'propertypro-media';
const REGION = process.env.AWS_REGION || 'us-east-1';

async function uploadToS3(fileBuffer, originalName, mimeType) {
  const ext = path.extname(originalName).toLowerCase() || '.jpg';
  const key = `listings/${uuidv4()}${ext}`;

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: fileBuffer,
    ContentType: mimeType,
  }));

  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
}

async function deleteFromS3(url) {
  const marker = '.amazonaws.com/';
  const idx = url.indexOf(marker);
  if (idx === -1) return;
  const key = url.slice(idx + marker.length);
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

module.exports = { uploadToS3, deleteFromS3 };
