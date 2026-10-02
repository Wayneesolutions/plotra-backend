const express = require('express');
const router = express.Router();
const { blogAdminGuard } = require('../middleware/blogAdminGuard');
const { loginLimiter } = require('../middleware/rateLimiter');
const {
  blogAdminLogin,
  blogAdminMe,
  blogImageUploadMiddleware,
  uploadBlogImage,
  listPostsAdmin,
  getPostAdmin,
  createPost,
  updatePost,
  deletePost,
} = require('../controllers/blogController');

/**
 * Standalone blog admin panel (frontend: /blog-admin).
 *
 * NOT part of the dealer dashboard (/api/v1/dashboard) or the super-admin
 * panel (/api/v1/admin): separate credentials (BLOG_ADMIN_EMAIL /
 * BLOG_ADMIN_PASSWORD), separate token (blogAdminGuard), no tenant context.
 */

/**
 * @route   POST /api/v1/blog-admin/login
 * @desc    { email, password } -> { token }. Rate-limited like dealer login.
 */
router.post('/login', loginLimiter, blogAdminLogin);

router.use(blogAdminGuard);

/**
 * @route   GET /api/v1/blog-admin/me
 * @desc    Validates a stored token when the panel loads
 */
router.get('/me', blogAdminMe);

/**
 * @route   POST /api/v1/blog-admin/upload-image
 * @desc    Multipart field "image" (JPEG/PNG/WebP, ≤5 MB) -> S3 blog/ -> { url }
 */
router.post('/upload-image', blogImageUploadMiddleware, uploadBlogImage);

/**
 * @route   GET    /api/v1/blog-admin/posts        every post, newest first (no body)
 * @route   POST   /api/v1/blog-admin/posts        publish a post
 * @route   GET    /api/v1/blog-admin/posts/:id    one post with body, for editing
 * @route   PUT    /api/v1/blog-admin/posts/:id    save changes
 * @route   DELETE /api/v1/blog-admin/posts/:id    delete
 * @desc    Body fields: meta_title, meta_description, slug, tags, title,
 *          description, image_url
 */
router.get('/posts', listPostsAdmin);
router.post('/posts', createPost);
router.get('/posts/:id', getPostAdmin);
router.put('/posts/:id', updatePost);
router.delete('/posts/:id', deletePost);

module.exports = router;
