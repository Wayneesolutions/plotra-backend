const multer = require('multer');
const { uploadToS3, deleteFromS3 } = require('../services/s3Service');

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_PHOTOS = 10;

const _upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, and WebP images are allowed.'));
    }
  },
});

// Export as named middleware so routes can insert it before tenantTransaction
const uploadMiddleware = (req, res, next) => {
  _upload.single('photo')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    next();
  });
};

async function getListingMedia(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { id: listingId } = req.params;
  const { tenant_id } = req.user;

  try {
    const listing = await knex('listings').where({ id: listingId, tenant_id }).select('id').first();
    if (!listing) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Listing not found.' } });
    }

    const mediaRow = await knex('listing_media').where({ listing_id: listingId }).select('photo_urls').first();
    return res.json({ success: true, photo_urls: mediaRow?.photo_urls || [] });
  } catch (err) {
    console.error('Failed to fetch listing media:', err.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch media.' } });
  }
}

async function uploadListingPhoto(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { id: listingId } = req.params;
  const { tenant_id } = req.user;

  try {
    const listing = await knex('listings').where({ id: listingId, tenant_id }).select('id').first();
    if (!listing) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Listing not found.' } });
    }

    if (!req.file) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No file uploaded.' } });
    }

    const mediaRow = await knex('listing_media').where({ listing_id: listingId }).first();
    const currentPhotos = mediaRow?.photo_urls || [];

    if (currentPhotos.length >= MAX_PHOTOS) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: `Maximum ${MAX_PHOTOS} photos allowed per listing.` },
      });
    }

    const url = await uploadToS3(req.file.buffer, req.file.originalname, req.file.mimetype);
    const updatedPhotos = [...currentPhotos, url];

    if (mediaRow) {
      await knex('listing_media').where({ listing_id: listingId }).update({ photo_urls: JSON.stringify(updatedPhotos) });
    } else {
      await knex('listing_media').insert({ listing_id: listingId, photo_urls: JSON.stringify(updatedPhotos) });
    }

    return res.status(201).json({ success: true, url, photo_urls: updatedPhotos });
  } catch (err) {
    console.error('S3 upload failed:', err.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to upload photo.' } });
  }
}

async function deleteListingPhoto(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { id: listingId } = req.params;
  const { tenant_id } = req.user;
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Photo URL is required.' } });
  }

  try {
    const listing = await knex('listings').where({ id: listingId, tenant_id }).select('id').first();
    if (!listing) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Listing not found.' } });
    }

    const mediaRow = await knex('listing_media').where({ listing_id: listingId }).first();
    const currentPhotos = mediaRow?.photo_urls || [];
    const updatedPhotos = currentPhotos.filter((p) => p !== url);

    if (updatedPhotos.length === currentPhotos.length) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Photo not found in this listing.' } });
    }

    await deleteFromS3(url);
    await knex('listing_media').where({ listing_id: listingId }).update({ photo_urls: JSON.stringify(updatedPhotos) });
    return res.json({ success: true, photo_urls: updatedPhotos });
  } catch (err) {
    console.error('S3 delete failed:', err.message);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete photo.' } });
  }
}

module.exports = { uploadMiddleware, getListingMedia, uploadListingPhoto, deleteListingPhoto };
