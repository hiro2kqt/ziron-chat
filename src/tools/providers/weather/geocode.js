/**
 * Google Geocoding API v4 - Native Fetch
 * Converts address/city name to coordinates
 */

/**
 * Geocode an address to coordinates
 * @param {Object} params
 * @param {string} params.address - Address or city name to geocode
 * @param {string} params.apiKey - Google API key
 * @returns {Promise<{lat: number, lon: number, formattedAddress: string}>}
 * @throws {Error} If no results found or API error
 */
export async function geocode({ address, apiKey }) {
  if (!apiKey) {
    throw new Error("Missing Google API key");
  }

  if (!address || !address.trim()) {
    throw new Error("Address is required");
  }

  const url = `https://geocode.googleapis.com/v4/geocode/address/${encodeURIComponent(address)}`;

  try {
    const response = await fetch(url, {
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "results.placeId,results.location,results.formattedAddress",
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Geocoding API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    const result = data.results?.[0];

    if (!result) {
      throw new Error(`No geocoding results found for: ${address}`);
    }

    return {
      lat: result.location?.latitude,
      lon: result.location?.longitude,
      formattedAddress: result.formattedAddress,
    };
  } catch (error) {
    if (error.message.includes("No geocoding results")) {
      throw error;
    }
    throw new Error(`Geocoding failed: ${error.message}`);
  }
}
