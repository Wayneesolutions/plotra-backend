exports.up = async (knex) => {
  await knex.schema.table('listing_media', (t) => {
    t.jsonb('photo_urls').notNullable().defaultTo('[]');
  });
};

exports.down = async (knex) => {
  await knex.schema.table('listing_media', (t) => {
    t.dropColumn('photo_urls');
  });
};
