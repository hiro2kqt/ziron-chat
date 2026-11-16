/**
 * Weather Tool - Main Entry Point
 * Supports two usecases:
 * 1. Chat query: getWeather({ city }) - geocodes then fetches
 * 2. Scheduled job: getWeather({ city?, lat, lon }) - skips geocoding
 */

import { formatLocal } from '../../../utils/time.js';
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
 * Format weather data to English text
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
  const dateStr = formatLocal(date, { year: "numeric", month: "2-digit", day: "2-digit" });
  const timeStr = formatLocal(date, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

  // Determine weather emoji based on condition
  let emoji = "🌤";
  const conditionLower = condition.toLowerCase();
  if (conditionLower.includes("rain")) emoji = "🌧";
  else if (conditionLower.includes("sun") || conditionLower.includes("clear")) emoji = "☀️";
  else if (conditionLower.includes("cloud")) emoji = "☁️";

  // Map wind direction to standard compass abbreviations
  const windDirectionMap = {
    NORTH: "N",
    NORTH_NORTHEAST: "NNE",
    NORTHEAST: "NE",
    EAST_NORTHEAST: "ENE",
    EAST: "E",
    EAST_SOUTHEAST: "ESE",
    SOUTHEAST: "SE",
    SOUTH_SOUTHEAST: "SSE",
    SOUTH: "S",
    SOUTH_SOUTHWEST: "SSW",
    SOUTHWEST: "SW",
    WEST_SOUTHWEST: "WSW",
    WEST: "W",
    WEST_NORTHWEST: "WNW",
    NORTHWEST: "NW",
    NORTH_NORTHWEST: "NNW",
  };

  const windDir = windDirectionMap[wind?.direction] || wind?.direction || "—";

  return `Weather in ${locationName} (${lat.toFixed(4)}, ${lon.toFixed(4)}):
${emoji} ${condition} — ${temp}°C, feels like ${feelsLike}°C
💧 Humidity: ${humidity}% | 🌧 Chance of rain: ${rainChance}%
💨 Wind: ${wind.speed} km/h from ${windDir} | ☁️ Cloud cover: ${cloudCover}%
🕐 Updated: ${dateStr} ${timeStr}`;
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
