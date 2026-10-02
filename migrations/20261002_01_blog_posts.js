/**
 * Blog posts for the public Plotraa website (plotraa.com/blog).
 *
 * Managed from the standalone blog admin panel (/blog-admin on the
 * frontend, /api/v1/blog-admin here) — deliberately NOT part of the dealer
 * dashboard or the super-admin panel: it has its own login and its own
 * token (see middleware/blogAdminGuard.js) and touches no tenant data.
 *
 * Not tenant data, so no tenant_id and no RLS — same trust boundary as
 * ad_placements / plans (platform-wide content, read by public routes).
 *
 * Columns are exactly the fields the admin form exposes:
 *   meta_title, meta_description, slug, tags, title, description (the post
 *   body, sanitized HTML), image_url — plus the usual timestamps.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('blog_posts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.string('slug', 160).notNullable().unique();
    table.string('title', 200).notNullable();
    table.text('description').notNullable();
    table.string('meta_title', 255).nullable();
    table.string('meta_description', 500).nullable();
    table.specificType('tags', 'text[]').notNullable().defaultTo('{}');
    table.string('image_url', 1024).nullable();
    table.timestamps(true, true);

    table.index(['created_at'], 'idx_blog_posts_created_at');
  });

  await knex.raw('CREATE INDEX idx_blog_posts_tags ON blog_posts USING GIN (tags)');
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('blog_posts');
};
