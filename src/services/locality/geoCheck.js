/**
 * Does a pin (from WhatsApp location share / Maps link / geocoder) fall inside a locality?
 * Uses the boundary polygon if one exists, otherwise centre + radius.
 */

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// GeoJSON Polygon: coordinates[0] is the outer ring of [lng, lat]
function pointInPolygon(lat, lng, geojson) {
  const ring = geojson && geojson.type === 'Polygon' && geojson.coordinates && geojson.coordinates[0];
  if (!ring || ring.length < 4) return null;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * @returns {{ verdict: 'inside'|'near'|'outside'|'unknown', distanceM: number|null, coordsVerified: boolean }}
 *  near = just past the edge (localities don't have hard walls; treat as OK but log it)
 */
function checkPin(locality, lat, lng) {
  const coordsVerified = locality.status === 'active';
  if (lat == null || lng == null || locality.center_lat == null || locality.center_lng == null) {
    return { verdict: 'unknown', distanceM: null, coordsVerified };
  }
  const distanceM = Math.round(haversineM(+lat, +lng, +locality.center_lat, +locality.center_lng));

  const inPoly = pointInPolygon(+lat, +lng, locality.boundary);
  if (inPoly === true) return { verdict: 'inside', distanceM, coordsVerified };

  const r = locality.radius_m || 1000;
  if (inPoly === null && distanceM <= r) return { verdict: 'inside', distanceM, coordsVerified };
  if (distanceM <= r * 1.5 + 300) return { verdict: 'near', distanceM, coordsVerified };
  return { verdict: 'outside', distanceM, coordsVerified };
}

/** Which localities could this pin belong to? Used to tell the dealer "pin Sarabha Nagar mein gira hai". */
function localitiesForPoint(localities, lat, lng, limit = 3) {
  return localities
    .filter((l) => l.center_lat != null && l.status !== 'disabled')
    .map((l) => {
      const { verdict, distanceM } = checkPin(l, lat, lng);
      return { id: l.id, name: l.name, kind: l.kind, verdict, distanceM, ratio: distanceM / (l.radius_m || 1000) };
    })
    .filter((x) => x.verdict === 'inside' || x.verdict === 'near')
    // Specific areas beat long road corridors when both contain the pin
    .sort((a, b) => (a.kind === 'road') - (b.kind === 'road') || a.ratio - b.ratio)
    .slice(0, limit);
}

module.exports = { checkPin, localitiesForPoint, haversineM, pointInPolygon };
