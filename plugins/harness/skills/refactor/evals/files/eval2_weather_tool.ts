import fetch from "node-fetch";

type WeatherResult = {
  temperature: number;
  conditions: string;
  location: string;
};

export default async function weatherTool(
  city: string,
  apiKey: string
): Promise<WeatherResult | null> {
  const url = `https://api.weather.com/v1/current?city=${city}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return {
    temperature: data.temp,
    conditions: data.weather,
    location: city,
  };
}

export function getWeatherToolDescription() {
  return "Fetches current weather for a given city";
}
