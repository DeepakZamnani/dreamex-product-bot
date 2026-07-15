const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const path = require('path');

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.AWS_S3_BUCKET;


const uploadToS3 = async (buffer, key, mimetype) => {
  const upload = new Upload({
    client: s3,
    params: {
      Bucket:      BUCKET,
      Key:         key,
      Body:        buffer,
      ContentType: mimetype,
    },
  });

  await upload.done();
  return `https://${BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
};


const deleteFromS3 = async (url) => {
  if (!url) return;
  try {
    const key = url.split('.amazonaws.com/')[1];
    if (!key) return;
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch {}
};


const brokerKey = (propertyName, brokerId, type, originalName) => {
  const ext      = path.extname(originalName).toLowerCase();
  const ts       = Date.now();
  const safeName = propertyName.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `broker/${safeName}-${brokerId}/${type}/${ts}${ext}`;
};

module.exports = { uploadToS3, deleteFromS3, brokerKey };
