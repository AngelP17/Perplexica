/* eslint-disable @next/next/no-img-element */
import { Cloud, Wind } from 'lucide-react';
import { useEffect, useState } from 'react';

const WeatherWidget = () => {
  const [data, setData] = useState({
    temperature: 0,
    condition: '',
    location: '',
    humidity: 0,
    windSpeed: 0,
    icon: '',
    temperatureUnit: 'C',
    windSpeedUnit: 'm/s',
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const getPreciseLocation = async () => {
    if (!navigator.geolocation) {
      return null;
    }

    try {
      const permissionResult = navigator.permissions?.query
        ? await navigator.permissions.query({
            name: 'geolocation',
          })
        : null;

      if (permissionResult && permissionResult.state !== 'granted') {
        return null;
      }
    } catch {
      return null;
    }

    return new Promise<{
      latitude: number;
      longitude: number;
      city?: string;
    } | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          let city: string | undefined;

          try {
            const res = await fetch(
              `https://api-bdc.io/data/reverse-geocode-client?latitude=${position.coords.latitude}&longitude=${position.coords.longitude}&localityLanguage=en`,
              {
                method: 'GET',
                headers: {
                  'Content-Type': 'application/json',
                },
              },
            );

            if (res.ok) {
              const data = await res.json();
              city = data.locality;
            }
          } catch {
            city = undefined;
          }

          resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            city,
          });
        },
        () => resolve(null),
        {
          enableHighAccuracy: false,
          maximumAge: 5 * 60 * 1000,
          timeout: 5000,
        },
      );
    });
  };

  useEffect(() => {
    const updateWeather = async () => {
      try {
        const location = await getPreciseLocation();
        const res = await fetch('/api/weather', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            lat: location?.latitude,
            lng: location?.longitude,
            city: location?.city,
            measureUnit: localStorage.getItem('measureUnit') ?? 'Metric',
          }),
        });

        const weatherData = await res.json();

        if (!res.ok) {
          setError(true);
          setLoading(false);
          return;
        }

        setData({
          temperature: weatherData.temperature,
          condition: weatherData.condition,
          location: weatherData.location,
          humidity: weatherData.humidity,
          windSpeed: weatherData.windSpeed,
          icon: weatherData.icon,
          temperatureUnit: weatherData.temperatureUnit,
          windSpeedUnit: weatherData.windSpeedUnit,
        });
        setError(false);
        setLoading(false);
      } catch {
        setError(true);
        setLoading(false);
      }
    };

    void updateWeather();
    const intervalId = setInterval(() => {
      void updateWeather();
    }, 30 * 1000);

    return () => clearInterval(intervalId);
  }, []);

  return (
    <div className="bg-light-secondary dark:bg-dark-secondary rounded-2xl border border-light-200 dark:border-dark-200 shadow-sm shadow-light-200/10 dark:shadow-black/25 flex flex-row items-center w-full h-24 min-h-[96px] max-h-[96px] px-3 py-2 gap-3">
      {loading ? (
        <>
          <div className="flex flex-col items-center justify-center w-16 min-w-16 max-w-16 h-full animate-pulse">
            <div className="h-10 w-10 rounded-full bg-light-200 dark:bg-dark-200 mb-2" />
            <div className="h-4 w-10 rounded bg-light-200 dark:bg-dark-200" />
          </div>
          <div className="flex flex-col justify-between flex-1 h-full py-1 animate-pulse">
            <div className="flex flex-row items-center justify-between">
              <div className="h-3 w-20 rounded bg-light-200 dark:bg-dark-200" />
              <div className="h-3 w-12 rounded bg-light-200 dark:bg-dark-200" />
            </div>
            <div className="h-3 w-16 rounded bg-light-200 dark:bg-dark-200 mt-1" />
            <div className="flex flex-row justify-between w-full mt-auto pt-1 border-t border-light-200 dark:border-dark-200">
              <div className="h-3 w-16 rounded bg-light-200 dark:bg-dark-200" />
              <div className="h-3 w-8 rounded bg-light-200 dark:bg-dark-200" />
            </div>
          </div>
        </>
      ) : error ? (
        <div className="flex h-full w-full items-center justify-center text-xs text-black/60 dark:text-white/60">
          Weather unavailable.
        </div>
      ) : (
        <>
          <div className="flex flex-col items-center justify-center w-16 min-w-16 max-w-16 h-full">
            {data.icon ? (
              <img
                src={`/weather-ico/${data.icon}.svg`}
                alt={data.condition}
                className="h-10 w-auto"
              />
            ) : (
              <Cloud className="h-10 w-10 text-black/40 dark:text-white/40" />
            )}
            <span className="text-base font-semibold text-black dark:text-white">
              {data.temperature}°{data.temperatureUnit}
            </span>
          </div>
          <div className="flex flex-col justify-between flex-1 h-full py-2">
            <div className="flex flex-row items-center justify-between">
              <span className="text-sm font-semibold text-black dark:text-white">
                {data.location}
              </span>
              <span className="flex items-center text-xs text-black/60 dark:text-white/60 font-medium">
                <Wind className="w-3 h-3 mr-1" />
                {data.windSpeed} {data.windSpeedUnit}
              </span>
            </div>
            <span className="text-xs text-black/50 dark:text-white/50 italic">
              {data.condition}
            </span>
            <div className="flex flex-row justify-between w-full mt-auto pt-2 border-t border-light-200/50 dark:border-dark-200/50 text-xs text-black/50 dark:text-white/50 font-medium">
              <span>Humidity {data.humidity}%</span>
              <span className="font-semibold text-black/70 dark:text-white/70">
                Now
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default WeatherWidget;
