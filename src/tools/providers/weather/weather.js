/**
 * Google Weather API - Native Fetch
 * Fetches current weather conditions by coordinates
 */

/**
 * Fetch current weather for coordinates
 * @param {Object} params
 * @param {number} params.lat - Latitude
 * @param {number} params.lon - Longitude
 * @param {string} params.apiKey - Google API key
 * @returns {Promise<Object>} Weather data object
 * @throws {Error} If API error occurs
 */
export async function fetchWeather({ lat, lon, apiKey }) {
  if (!apiKey) {
    throw new Error("Missing Google API key");
  }

  if (lat === undefined || lon === undefined) {
    throw new Error("Latitude and longitude are required");
  }

  const url = new URL("https://weather.googleapis.com/v1/currentConditions:lookup");
  url.searchParams.append("key", apiKey);
  url.searchParams.append("location.latitude", lat);
  url.searchParams.append("location.longitude", lon);
  url.searchParams.append("languageCode", "vi");
  url.searchParams.append("unitsSystem", "METRIC");

  try {
    const response = await fetch(url.toString());

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Weather API error: ${response.status} - ${error}`);
    }

    const data = await response.json();

    return {
      time: data.currentTime,
      condition: data.weatherCondition?.description?.text || "Không rõ",
      temp: data.temperature?.degrees,
      feelsLike: data.feelsLikeTemperature?.degrees,
      humidity: data.relativeHumidity,
      uvIndex: data.uvIndex,
      wind: {
        speed: data.wind?.speed?.value,
        direction: data.wind?.direction?.cardinal || "N/A",
      },
      visibility: data.visibility?.distance,
      cloudCover: data.cloudCover,
      rainChance: data.precipitation?.probability?.percent ?? 0,
    };
  } catch (error) {
    throw new Error(`Weather fetch failed: ${error.message}`);
  }
}
