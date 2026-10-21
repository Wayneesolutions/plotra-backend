// src/utils/addressMatch.js
//
// Same-property check used by agent listing intake (agentIntakeController.js)
// to tell a correction to the listing awaiting approval from a new property.

function normalizeAddressText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Heuristic for "this message is about a different property" vs. "this is
 * a correction to the one already awaiting approval." Deliberately loose:
 * treats one address/building name as a match for another if either
 * contains the other once normalized (so "DLF Chandigarh One" still
 * matches "DLF Chandigarh One, Tower 3", and "Sector 45 Mohali" matches
 * "sector-45, Mohali!!"). Only called when the new message actually stated
 * a raw_address/building name — if there's nothing to compare, this
 * assumes it's the same property rather than guessing.
 *
 * Building name is checked first and, when both sides have one, decides
 * the result on its own — two different buildings in the same city
 * ("Agi Flats, Ludhiana" vs. an existing "Hero Homes, Ludhiana" draft)
 * would otherwise both contain the shared "ludhiana" substring and be
 * wrongly read as the same property if only raw_address were compared.
 */
function isDifferentProperty(newFields, existingListing) {
  const newBuilding = normalizeAddressText(newFields.building_name);
  const existingBuilding = normalizeAddressText(existingListing.building_name);
  if (newBuilding && existingBuilding) {
    return !newBuilding.includes(existingBuilding) && !existingBuilding.includes(newBuilding);
  }

  const a = normalizeAddressText(newFields.raw_address);
  const b = normalizeAddressText(existingListing.raw_address);
  if (!a || !b) return false;
  if (a === b) return false;
  if (a.includes(b) || b.includes(a)) return false;

  // The same address written again in a different order or with more parts
  // ("Main Market, Ram Nagar, Ludhiana, Punjab 141003" for a listing saved as
  // "Ram Nagar Main Market Ludhiana") used to count as a different property
  // and spawned a second draft. Compare words instead: house/plot/sector
  // numbers must agree, then most words of the shorter address must appear in
  // the longer one. Pincodes are ignored (one side often lacks it).
  const words = (t) => t.split(' ').filter((w) => w && !/^[1-9]\d{5}$/.test(w));
  const aw = words(a);
  const bw = words(b);
  const aNums = aw.filter((w) => /\d/.test(w));
  const bNums = bw.filter((w) => /\d/.test(w));
  if (aNums.length && bNums.length && !aNums.some((n) => bNums.includes(n))) return true;
  const [short, long] = aw.length <= bw.length ? [aw, bw] : [bw, aw];
  if (!short.length) return false;
  const longSet = new Set(long);
  const shared = short.filter((w) => longSet.has(w)).length;
  return shared / short.length < 0.7;
}

module.exports = { isDifferentProperty, normalizeAddressText };
