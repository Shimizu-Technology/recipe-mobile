import Constants from 'expo-constants';

function normalizeConfiguredUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('EXPO_PUBLIC_API_URL must be a valid absolute URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('EXPO_PUBLIC_API_URL must use http or https.');
  }

  return value.replace(/\/+$/, '');
}

export function resolveApiBaseUrl(): string {
  const configuredUrl = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (configuredUrl) {
    return normalizeConfiguredUrl(configuredUrl);
  }

  if (!__DEV__) {
    throw new Error('EXPO_PUBLIC_API_URL is required for non-development builds.');
  }

  const debuggerHost = Constants.expoConfig?.hostUri || Constants.manifest?.debuggerHost;
  const host = debuggerHost?.split(':')[0]?.trim();
  if (!host) {
    throw new Error(
      'Could not detect the local API host. Set EXPO_PUBLIC_API_URL explicitly; production fallback is disabled.'
    );
  }

  return `http://${host}:8000`;
}

export const API_BASE_URL = resolveApiBaseUrl();
