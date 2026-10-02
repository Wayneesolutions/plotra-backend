/**
 * Blog — standalone admin panel + public read endpoints.
 *
 * Admin side is mounted at /api/v1/blog-admin (routes/blogAdmin.js) behind
 * blogAdminGuard: its own login, its own token, nothing shared with the
 * dealer dashboard or the super-admin panel. Public side is mounted under
 * /api/v1/public/blog (routes/public.js).
 *
 * blog_posts is platform content, not tenant data (no tenant_id, no RLS),
 * so every query here uses the plain connection pool.
 */

const crypto = require('crypto');
const multer = require('multer');
const { uploadToS3, deleteFromS3 } = require('../services/s3Service');
const { signBlogAdminToken } = require('../middleware/blogAdminGuard');
const {
  sanitizeBlogHtml,
  htmlToText,
  slugify,
  isValidSlug,
  normalizeTags,
  SLUG_MAX,
} = require('../utils/blogContent');

const TITLE_MAX = 200;
const META_TITLE_MAX = 255;
const META_DESCRIPTION_MAX = 500;
const IMAGE_URL_MAX = 1024;
const BODY_MAX_CHARS = 200000;

const LIST_COLUMNS = [
  'id', 'slug', 'title', 'meta_title', 'meta_description', 'tags', 'image_url', 'created_at', 'updated_at',
];

const validationError = (res, message) =>
  res.status(400).json({ error: { code: 'VALIDATION_ERROR', message } });

const internalError = (res, message) =>
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message } });

const notFound = (res) =>
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Blog post not found.' } });

const isUuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value));

/* --------------------------------- LOGIN --------------------------------- */

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * POST /api/v1/blog-admin/login  { email, password }
 * Credentials come from BLOG_ADMIN_EMAIL / BLOG_ADMIN_PASSWORD — there is no
 * users row behind this login, on purpose (see blogAdminGuard.js).
 */
async function blogAdminLogin(req, res) {
  const expectedEmail = (process.env.BLOG_ADMIN_EMAIL || '').trim().toLowerCase();
  const expectedPassword = process.env.BLOG_ADMIN_PASSWORD || '';

  if (!expectedEmail || !expectedPassword) {
    return res.status(503).json({
      error: {
        code: 'NOT_CONFIGURED',
        message: 'Blog admin login is not set up on the server yet (BLOG_ADMIN_EMAIL / BLOG_ADMIN_PASSWORD).',
      },
    });
  }

  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (!email || !password) {
    return validationError(res, 'Email and password are required.');
  }

  const emailOk = safeEqual(email, expectedEmail);
  const passwordOk = safeEqual(password, expectedPassword);
  if (!emailOk || !passwordOk) {
    return res.status(401).json({
      error: { code: 'INVALID_CREDENTIALS', message: 'Wrong email or password.' },
    });
  }

  return res.json({ success: true, token: signBlogAdminToken(expectedEmail), email: expectedEmail });
}

/** GET /api/v1/blog-admin/me — lets the panel check a stored token on load. */
function blogAdminMe(req, res) {
  return res.json({ success: true, email: req.blogAdmin.email });
}

/* ------------------------------ IMAGE UPLOAD ----------------------------- */

const BLOG_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const BLOG_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

const _blogImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BLOG_IMAGE_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (BLOG_IMAGE_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG and WebP images are allowed.'));
  },
});

/** multer middleware for POST /blog-admin/upload-image (field name: "image") */
function blogImageUploadMiddleware(req, res, next) {
  _blogImageUpload.single('image')(req, res, (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'Image must be 5 MB or smaller.' : err.message;
      return validationError(res, message);
    }
    return next();
  });
}

/**
 * POST /api/v1/blog-admin/upload-image  (multipart, field "image")
 * Uploads to S3 under blog/ and returns { url } for the form to submit as
 * image_url — same two-step pattern as the ad creative upload.
 */
async function uploadBlogImage(req, res) {
  if (!req.file) return validationError(res, 'No image uploaded.');
  try {
    const url = await uploadToS3(req.file.buffer, req.file.originalname, req.file.mimetype, 'blog');
    return res.status(201).json({ success: true, url });
  } catch (error) {
    console.error('Blog image upload failed:', error.message);
    return internalError(res, 'Failed to upload image.');
  }
}

/** Best-effort cleanup of an image this panel uploaded (never throws). */
async function removeUploadedImage(url) {
  if (!url || !/\.amazonaws\.com\/blog\//.test(url)) return;
  try {
    await deleteFromS3(url);
  } catch (error) {
    console.error('Blog image cleanup failed:', error.message);
  }
}

/* ------------------------------- VALIDATION ------------------------------ */

/**
 * Turns a request body into a clean row, or returns { error }.
 * The form has exactly seven fields: meta_title, meta_description, slug,
 * tags, title, description, image_url.
 */
function buildPostRow(body = {}) {
  const title = String(body.title ?? '').replace(/\s+/g, ' ').trim();
  if (!title) return { error: 'Title is required.' };
  if (title.length > TITLE_MAX) return { error: `Title must be ${TITLE_MAX} characters or fewer.` };

  if (String(body.description ?? '').length > BODY_MAX_CHARS) {
    return { error: 'Description is too long.' };
  }
  const description = sanitizeBlogHtml(body.description);
  if (!htmlToText(description)) return { error: 'Description is required.' };

  const slugInput = String(body.slug ?? '').trim();
  const slug = slugInput ? slugInput.toLowerCase() : slugify(title);
  if (!isValidSlug(slug)) {
    return {
      error: `Slug can only use lowercase letters, numbers and single hyphens (max ${SLUG_MAX} characters), e.g. "buying-a-plot-in-ludhiana".`,
    };
  }

  const metaTitle = String(body.meta_title ?? '').replace(/\s+/g, ' ').trim();
  if (metaTitle.length > META_TITLE_MAX) {
    return { error: `Meta title must be ${META_TITLE_MAX} characters or fewer.` };
  }

  const metaDescription = String(body.meta_description ?? '').replace(/\s+/g, ' ').trim();
  if (metaDescription.length > META_DESCRIPTION_MAX) {
    return { error: `Meta description must be ${META_DESCRIPTION_MAX} characters or fewer.` };
  }

  const imageUrl = String(body.image_url ?? '').trim();
  if (imageUrl && (!/^https:\/\//i.test(imageUrl) || imageUrl.length > IMAGE_URL_MAX)) {
    return { error: 'Image must be an https:// URL — upload it from the form.' };
  }

  return {
    row: {
      title,
      description,
      slug,
      meta_title: metaTitle || null,
      meta_description: metaDescription || null,
      tags: normalizeTags(body.tags),
      image_url: imageUrl || null,
    },
  };
}

const isUniqueViolation = (error) => error && error.code === '23505';

const slugTaken = (res) =>
  res.status(409).json({
    error: { code: 'SLUG_TAKEN', message: 'Another post already uses this slug. Change the slug and save again.' },
  });

/* ------------------------------ ADMIN — CRUD ----------------------------- */

/** GET /api/v1/blog-admin/posts — every post, newest first (no body). */
async function listPostsAdmin(req, res) {
  const knex = req.app.get('db');
  try {
    const posts = await knex('blog_posts').select(LIST_COLUMNS).orderBy('created_at', 'desc');
    return res.json({ success: true, posts });
  } catch (error) {
    console.error('Blog admin list failed:', error.message);
    return internalError(res, 'Failed to load blog posts.');
  }
}

/** GET /api/v1/blog-admin/posts/:id — one post including the body, for editing. */
async function getPostAdmin(req, res) {
  const knex = req.app.get('db');
  if (!isUuid(req.params.id)) return notFound(res);
  try {
    const post = await knex('blog_posts').where({ id: req.params.id }).first();
    if (!post) return notFound(res);
    return res.json({ success: true, post });
  } catch (error) {
    console.error('Blog admin get failed:', error.message);
    return internalError(res, 'Failed to load the blog post.');
  }
}

/** POST /api/v1/blog-admin/posts */
async function createPost(req, res) {
  const knex = req.app.get('db');
  const { row, error } = buildPostRow(req.body);
  if (error) return validationError(res, error);

  try {
    const [post] = await knex('blog_posts').insert(row).returning('*');
    return res.status(201).json({ success: true, post });
  } catch (err) {
    if (isUniqueViolation(err)) return slugTaken(res);
    console.error('Blog post create failed:', err.message);
    return internalError(res, 'Failed to publish the blog post.');
  }
}

/** PUT /api/v1/blog-admin/posts/:id — full replace of the seven form fields. */
async function updatePost(req, res) {
  const knex = req.app.get('db');
  if (!isUuid(req.params.id)) return notFound(res);

  const { row, error } = buildPostRow(req.body);
  if (error) return validationError(res, error);

  try {
    const existing = await knex('blog_posts').where({ id: req.params.id }).first('id', 'image_url');
    if (!existing) return notFound(res);

    const [post] = await knex('blog_posts')
      .where({ id: req.params.id })
      .update({ ...row, updated_at: knex.fn.now() })
      .returning('*');

    if (existing.image_url && existing.image_url !== post.image_url) {
      await removeUploadedImage(existing.image_url);
    }

    return res.json({ success: true, post });
  } catch (err) {
    if (isUniqueViolation(err)) return slugTaken(res);
    console.error('Blog post update failed:', err.message);
    return internalError(res, 'Failed to save the blog post.');
  }
}

/** DELETE /api/v1/blog-admin/posts/:id */
async function deletePost(req, res) {
  const knex = req.app.get('db');
  if (!isUuid(req.params.id)) return notFound(res);

  try {
    const [deleted] = await knex('blog_posts').where({ id: req.params.id }).del().returning(['id', 'image_url']);
    if (!deleted) return notFound(res);
    await removeUploadedImage(deleted.image_url);
    return res.json({ success: true });
  } catch (error) {
    console.error('Blog post delete failed:', error.message);
    return internalError(res, 'Failed to delete the blog post.');
  }
}

/* --------------------------------- PUBLIC -------------------------------- */

/**
 * GET /api/v1/public/blog?tag=&page=&limit=
 * Newest first, without the body. Also returns every tag in use, for the
 * filter row on the blog index.
 */
async function listPublicPosts(req, res) {
  const knex = req.app.get('db');
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 12));
  const tag = String(req.query.tag || '').trim();

  try {
    const base = knex('blog_posts');
    if (tag) base.whereRaw('lower(?) = ANY (SELECT lower(t) FROM unnest(tags) AS t)', [tag]);

    const [{ count }] = await base.clone().count('* as count');
    const posts = await base
      .clone()
      .select(LIST_COLUMNS)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset((page - 1) * limit);

    const tagRows = await knex.raw(
      'SELECT t AS tag, count(*)::int AS count FROM blog_posts, unnest(tags) AS t GROUP BY t ORDER BY count(*) DESC, t ASC LIMIT 40'
    );

    return res.json({
      success: true,
      posts,
      tags: tagRows.rows.map((r) => r.tag),
      pagination: { page, limit, total: Number(count), pages: Math.max(1, Math.ceil(Number(count) / limit)) },
    });
  } catch (error) {
    console.error('Public blog list failed:', error.message);
    return internalError(res, 'Failed to load blog posts.');
  }
}

/** GET /api/v1/public/blog/:slug — one post with its body. */
async function getPublicPost(req, res) {
  const knex = req.app.get('db');
  const slug = String(req.params.slug || '').toLowerCase();
  if (!isValidSlug(slug)) return notFound(res);

  try {
    const post = await knex('blog_posts').where({ slug }).first();
    if (!post) return notFound(res);
    return res.json({ success: true, post });
  } catch (error) {
    console.error('Public blog post fetch failed:', error.message);
    return internalError(res, 'Failed to load the blog post.');
  }
}

module.exports = {
  blogAdminLogin,
  blogAdminMe,
  blogImageUploadMiddleware,
  uploadBlogImage,
  listPostsAdmin,
  getPostAdmin,
  createPost,
  updatePost,
  deletePost,
  listPublicPosts,
  getPublicPost,
  // exported for tests
  buildPostRow,
};
