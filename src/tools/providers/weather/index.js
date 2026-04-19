/**
 * Weather Tool - Main Entry Point
 * Supports two usecases:
 * 1. Chat query: getWeather({ city }) - geocodes then fetches
 * 2. Scheduled job: getWeather({ city?, lat, lon }) - skips geocoding
 */

import { fileURLToPath } from "url";
import { loadConfig } from "../../../config/index.js";
import { geocode } from "./geocode.js";
import { fetchWeather } from "./weather.js";

/**
 * Get weather for a location
 * @param {Object} params
 * @param {string} [params.city] - City name (required if no lat/lon)
 * @param {number} [params.lat] - Latitude (skip geocoding if provided)
 * @param {number} [params.lon] - Longitude (skip geocoding if provided)
 * @returns {Promise<Object>} Weather data with location info
 * @throws {Error} If API key missing or API errors
 */
export async function getWeather({ city, lat, lon }) {
  const config = loadConfig();
  const apiKey = config.tools?.weather?.googleApiKey;

  if (!apiKey) {
    throw new Error(
      "Missing Google API key. Add tools.weather.googleApiKey to config.json"
    );
  }

  let locationName;
  let latitude = lat;
  let longitude = lon;
  let formattedAddress;

  // Usecase 1: Only city provided - need to geocode
  if (latitude === undefined || longitude === undefined) {
    if (!city) {
      throw new Error("Either city or lat/lon must be provided");
    }

    const geocodeResult = await geocode({ address: city, apiKey });
    latitude = geocodeResult.lat;
    longitude = geocodeResult.lon;
    formattedAddress = geocodeResult.formattedAddress;
    // Strip leading postal code/number from formatted address
    locationName = formattedAddress.replace(/^\d+\s*/, '');
  } else {
    // Usecase 2: Coordinates provided - skip geocoding
    locationName = city || `${latitude}, ${longitude}`;
  }

  // Fetch weather data
  const weatherData = await fetchWeather({ lat: latitude, lon: longitude, apiKey });

  return {
    locationName,
    lat: latitude,
    lon: longitude,
    time: weatherData.time,
    condition: weatherData.condition,
    temp: weatherData.temp,
    feelsLike: weatherData.feelsLike,
    humidity: weatherData.humidity,
    rainChance: weatherData.rainChance,
    wind: weatherData.wind,
    cloudCover: weatherData.cloudCover,
    uvIndex: weatherData.uvIndex,
    visibility: weatherData.visibility,
  };
}

/**
 * Format weather data to Vietnamese text
 * @param {Object} result - Weather result from getWeather()
 * @returns {string} Formatted weather text
 */
export function formatWeather(result) {
  const {
    locationName,
    lat,
    lon,
    condition,
    temp,
    feelsLike,
    humidity,
    rainChance,
    wind,
    cloudCover,
    uvIndex,
    time,
  } = result;

  // Format date time from ISO string
  const date = new Date(time);
  const dateStr = date.toLocaleDateString("vi-VN");
  const timeStr = date.toLocaleTimeString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
  });

  // Determine weather emoji based on condition
  let emoji = "🌤";
  const conditionLower = condition.toLowerCase();
  if (conditionLower.includes("mưa")) emoji = "🌧";
  else if (conditionLower.includes("nắng")) emoji = "☀️";
  else if (conditionLower.includes("mây")) emoji = "☁️";
  else if (conditionLower.includes("nhiều mây")) emoji = "🌤";

  // Map wind direction to Vietnamese abbreviations
  const windDirectionMap = {
    NORTH: "B",
    NORTH_NORTHEAST: "BBĐ",
    NORTHEAST: "BĐ",
    EAST_NORTHEAST: "ĐBĐ",
    EAST: "Đ",
    EAST_SOUTHEAST: "ĐNĐ",
    SOUTHEAST: "NĐ",
    SOUTH_SOUTHEAST: "NNĐ",
    SOUTH: "N",
    SOUTH_SOUTHWEST: "NTN",
    SOUTHWEST: "TN",
    WEST_SOUTHWEST: "TTN",
    WEST: "T",
    WEST_NORTHWEST: "TTB",
    NORTHWEST: "TB",
    NORTH_NORTHWEST: "BTB",
  };

  const windDir = windDirectionMap[wind?.direction] || wind?.direction || "—";

  return `Thời tiết tại ${locationName} (${lat.toFixed(4)}, ${lon.toFixed(4)}):
${emoji} ${condition} — ${temp}°C, cảm giác như ${feelsLike}°C
💧 Độ ẩm: ${humidity}% | 🌧 Khả năng mưa: ${rainChance}%
💨 Gió: ${wind.speed} km/h hướng ${windDir} | ☁️ Mây: ${cloudCover}%
🕐 Cập nhật: ${dateStr} ${timeStr}`;
}

// Test block
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      // Test usecase 1: chỉ có city (geocode + fetch)
      console.log("=== Usecase 1 (geocode) ===");
      const r1 = await getWeather({ city: "Dortmund" });
      console.log(formatWeather(r1));
      console.log("lat:", r1.lat, "lon:", r1.lon);
      console.log();

      // Test usecase 2: có tọa độ (skip geocode)
      console.log("=== Usecase 2 (tọa độ) ===");
      const r2 = await getWeather({
        city: "Dortmund",
        lat: 51.5132,
        lon: 7.474,
      });
      console.log(formatWeather(r2));
    } catch (error) {
      console.error("Test failed:", error.message);
      process.exit(1);
    }
  })();
}
