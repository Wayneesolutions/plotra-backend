/**
 * Patches a listing's traced plot boundary (GeoJSON polygon) onto
 * listing_media. Tenant-scoped — verifies the listing belongs to the
 * requesting user's tenant before writing anything.
 */
async function updateListingBoundary(req, res) {
  const knex = req.dbTrx || req.app.get('db');
  const { id } = req.params;
  const { tenant_id } = req.user;
  const { boundaryGeoJSON } = req.body;

  if (!boundaryGeoJSON || !boundaryGeoJSON.geometry) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'A valid GeoJSON feature (with a geometry) is required.' }
    });
  }

  try {
    const listing = await knex('listings').where({ id, tenant_id }).first();

    if (!listing) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Listing not found in your tenant.' }
      });
    }

    const existingMedia = await knex('listing_media').where({ listing_id: id }).first();

    if (existingMedia) {
      await knex('listing_media')
        .where({ listing_id: id })
        .update({ plot_boundary_geojson: JSON.stringify(boundaryGeoJSON) });
    } else {
      await knex('listing_media').insert({
        listing_id: id,
        plot_boundary_geojson: JSON.stringify(boundaryGeoJSON)
      });
    }

    return res.status(200).json({ success: true, message: 'Plot boundary saved.' });

  } catch (error) {
    console.error('Failed to update listing boundary:', error);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to save plot boundary.' }
    });
  }
}

module.exports = { updateListingBoundary };
