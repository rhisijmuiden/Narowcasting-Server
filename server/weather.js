'use strict';
// Weather via Open-Meteo (free, no API key). Cached per location for 15 minutes.
const cache = new Map();

async function getWeather(lat, lon) {
  const key = `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 15 * 60 * 1000) return hit.data;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}` +
    '&current=temperature_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=4&timezone=auto';
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Weather service returned ${res.status}`);
  const data = await res.json();
  cache.set(key, { at: Date.now(), data });
  return data;
}

module.exports = { getWeather };
