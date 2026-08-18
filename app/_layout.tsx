import FontAwesome from '@expo/vector-icons/FontAwesome';
import { DarkTheme, DefaultTheme, ThemeProvider as NavigationThemeProvider } from '@react-navigation/native';
import { QueryClientProvider } from '@tanstack/react-query';
import { ClerkProvider, ClerkLoaded, useAuth, useUser } from '@clerk/clerk-expo';
import { useFonts } from 'expo-font';
import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_600SemiBold,
  DMSans_700Bold,
} from '@expo-google-fonts/dm-sans';
import {
  Fraunces_600SemiBold,
  Fraunces_700Bold,
} from '@expo-google-fonts/fraunces';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import 'react-native-reanimated';
import { ShareIntentProvider } from 'expo-share-intent';

import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { TimerProvider } from '@/contexts/TimerContext';
import { queryClient } from '@/lib/queryClient';
import { tokenCache, CLERK_PUBLISHABLE_KEY } from '@/lib/auth';
import { api } from '@/lib/api';
import { AppLoadingSkeleton } from '@/components/Skeleton';
import { OfflineBanner } from '@/components/OfflineBanner';
import { FloatingTimerOverlay } from '@/components/FloatingTimerOverlay';
import FloatingChatButton from '@/components/FloatingChatButton';
import { initSentry, setSentryUser, addBreadcrumb, captureError, withSentry } from '@/lib/sentry';
import { useHandleShareIntent } from '@/hooks/useShareIntent';

// Initialize Sentry as early as possible
initSentry();

export {
  // Catch any errors thrown by the Layout component.
  ErrorBoundary,
} from 'expo-router';

export const unstable_settings = {
  // Ensure that reloading on `/modal` keeps a back button present.
  initialRouteName: '(tabs)',
};

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
    ...FontAwesome.font,
    // Håfa Recipes brand typography
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_600SemiBold,
    DMSans_700Bold,
    Fraunces_600SemiBold,
    Fraunces_700Bold,
  });

  // Expo Router uses Error Boundaries to catch errors in the navigation tree.
  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) {
      // Hide splash screen quickly - we'll show our own skeleton
      SplashScreen.hideAsync();
      addBreadcrumb('navigation', 'App loaded, splash screen hidden');
    }
  }, [loaded]);

  // Show skeleton loading instead of blank/splash screen
  if (!loaded) {
    return (
      <View style={{ flex: 1, backgroundColor: '#101411' }}>
        <AppLoadingSkeleton />
      </View>
    );
  }

  return (
    <ThemeProvider>
      <ShareIntentProvider>
        <ClerkProvider 
          publishableKey={CLERK_PUBLISHABLE_KEY} 
          tokenCache={tokenCache}
        >
          <ClerkLoaded>
            <RootLayoutNav />
          </ClerkLoaded>
        </ClerkProvider>
      </ShareIntentProvider>
    </ThemeProvider>
  );
}

// Wrap with Sentry for error boundary and performance tracking
export default withSentry(RootLayout);

/**
 * Handles auth-based routing.
 * 
 * Tab screens handle guest access themselves with SignInBanner.
 * This only handles:
 * - Redirecting signed-in users from auth screens to main app
 * - Protecting add-recipe modal from guests
 */
function AuthProtection({ children }: { children: React.ReactNode }) {
  const { isSignedIn, isLoaded } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!isLoaded) return;

    const inAuthGroup = segments[0] === '(auth)';
    
    // User signed in on auth screen -> redirect to main app
    if (isSignedIn && inAuthGroup) {
      router.replace('/(tabs)');
      return;
    }

    // Only protect add-recipe modal from guests
    // Tab screens handle their own guest access with SignInBanner
    if (!isSignedIn && segments[0] === 'add-recipe') {
      router.replace('/(tabs)/discover');
    }
  }, [isSignedIn, isLoaded, segments]);

  return <>{children}</>;
}

/**
 * Component that syncs auth token with API client.
 * Passes a token getter function so fresh tokens are fetched on each request.
 * Also syncs user context with Sentry for error attribution.
 * 
 * IMPORTANT: Clears the query cache when the user changes to prevent
 * stale data from a previous user showing to a new user.
 */
function AuthTokenSync({ children }: { children: React.ReactNode }) {
  const { getToken, isSignedIn, isLoaded } = useAuth();
  const { user } = useUser();
  
  // `undefined` means auth has not completed its first load yet. Once loaded,
  // `null` is a real signed-out subject and must participate in transitions.
  const previousUserIdRef = useRef<string | null | undefined>(undefined);
  const migrationAttemptedForUserRef = useRef<string | null>(null);
  const migrationRetryCountRef = useRef<Record<string, number>>({});
  const [migrationRetryNonce, setMigrationRetryNonce] = useState(0);

  // Use useLayoutEffect to set token getter BEFORE children render/effects run
  // This ensures token is available before any API calls
  useLayoutEffect(() => {
    if (!isLoaded) return;
    
    if (isSignedIn) {
      // Pass the getToken function - it will be called on each request
      // to get a fresh token (Clerk tokens expire in ~60 seconds)
      // Use our custom JWT template that includes public_metadata (for admin role)
      api.setTokenGetter(async () => {
        return await getToken({ template: "recipe-extractor-public-metadata" });
      });
    } else {
      api.setTokenGetter(null);
    }
  }, [isSignedIn, isLoaded, getToken]);

  // CRITICAL: Clear cache when user changes to prevent data leakage
  // This handles the case where someone signs out and a different user signs in
  useEffect(() => {
    if (!isLoaded) return;
    
    const currentUserId = user?.id ?? null;
    const previousUserId = previousUserIdRef.current;
    
    // Skip the first resolved auth state; a new QueryClient has no prior
    // account data. Every later subject transition (A -> signed out, signed
    // out -> B, or A -> B) cancels requests and clears private cache data.
    if (previousUserId !== undefined && previousUserId !== currentUserId) {
      void queryClient.cancelQueries();
      queryClient.clear();
      addBreadcrumb('auth', 'Query cache cleared due to user change', {
        wasAuthenticated: previousUserId !== null,
        isAuthenticated: currentUserId !== null,
        accountChanged: previousUserId !== null && currentUserId !== null,
      });
    }
    
    // Update the ref for next comparison
    previousUserIdRef.current = currentUserId;
  }, [user?.id, isLoaded]);

  // During the Clerk production cutover, the API can migrate legacy data from
  // the old Clerk development user ID to the new production user ID. This call
  // is safe and idempotent; it no-ops when migration is disabled or already done.
  useEffect(() => {
    if (!isLoaded) return;

    if (!isSignedIn || !user?.id) {
      migrationAttemptedForUserRef.current = null;
      return;
    }

    if (migrationAttemptedForUserRef.current === user.id) return;
    migrationAttemptedForUserRef.current = user.id;

    let isCancelled = false;
    let retryTimeout: ReturnType<typeof setTimeout> | undefined;

    api.migrateLegacyAccount()
      .then((result) => {
        if (isCancelled) return;

        delete migrationRetryCountRef.current[user.id];

        if (result.migrated) {
          queryClient.clear();
          addBreadcrumb('auth', 'Legacy account data migrated', {
            status: result.status,
            rowsUpdated: result.rows_updated,
          });
        }
      })
      .catch((error) => {
        if (isCancelled) return;

        // Do not block sign-in if the migration bridge is unavailable. Reset the
        // guard and retry a few times for transient network/token timing issues.
        migrationAttemptedForUserRef.current = null;

        const retryCount = migrationRetryCountRef.current[user.id] ?? 0;
        const shouldRetry = retryCount < 3;
        if (shouldRetry) {
          migrationRetryCountRef.current[user.id] = retryCount + 1;
          retryTimeout = setTimeout(() => {
            setMigrationRetryNonce((nonce) => nonce + 1);
          }, Math.min(30000, 1000 * 2 ** retryCount));
        }

        addBreadcrumb(
          'auth',
          'Legacy account migration check failed',
          { retryCount, willRetry: shouldRetry },
          'warning'
        );
        captureError(error instanceof Error ? error : new Error('Legacy account migration check failed'), {
          tags: { area: 'auth', action: 'legacy-account-migration' },
          extra: { retryCount, willRetry: shouldRetry },
        });
      });

    return () => {
      isCancelled = true;
      if (retryTimeout) {
        clearTimeout(retryTimeout);
      }
    };
  }, [isLoaded, isSignedIn, user?.id, migrationRetryNonce]);

  // Sync user context with Sentry
  useEffect(() => {
    if (!isLoaded) return;
    
    if (isSignedIn && user) {
      setSentryUser({
        id: user.id,
        email: user.primaryEmailAddress?.emailAddress,
        username: user.username,
      });
      addBreadcrumb('auth', 'User signed in', { userId: user.id });
    } else {
      setSentryUser(null);
      if (isLoaded) {
        addBreadcrumb('auth', 'User signed out or not authenticated');
      }
    }
  }, [isSignedIn, isLoaded, user]);

  return <>{children}</>;
}

/**
 * Component that handles incoming share intents.
 * Must be rendered within ShareIntentProvider and after navigation is ready.
 */
function ShareIntentHandler({ children }: { children: React.ReactNode }) {
  useHandleShareIntent();
  return <>{children}</>;
}

function RootLayoutNav() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? 'light'];

  return (
    <QueryClientProvider client={queryClient}>
      <NavigationThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <TimerProvider>
        <AuthTokenSync>
          <AuthProtection>
            <ShareIntentHandler>
            {/* Global offline indicator */}
            <OfflineBanner />
            {/* Floating timer when leaving cook mode with active timers */}
            <FloatingTimerOverlay />
            {/* Floating chat button for cooking assistant */}
            <FloatingChatButton />
            <Stack
              screenOptions={{
                headerStyle: { backgroundColor: colors.background },
                headerTintColor: colors.tint,
                headerTitleStyle: { color: colors.text, fontWeight: '600', fontFamily: 'DMSans_600SemiBold' },
                headerShadowVisible: false,
                headerBackTitle: 'Back',
              }}
            >
              <Stack.Screen name="(auth)" options={{ headerShown: false }} />
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen 
                name="recipe/[id]" 
                options={{ 
                  headerTitle: 'Recipe',
                }} 
              />
              <Stack.Screen 
                name="add-recipe" 
                options={{ 
                  headerTitle: 'Add Recipe',
                  presentation: 'modal',
                }} 
              />
              <Stack.Screen name="modal" options={{ presentation: 'modal' }} />
            </Stack>
            </ShareIntentHandler>
          </AuthProtection>
        </AuthTokenSync>
        </TimerProvider>
      </NavigationThemeProvider>
    </QueryClientProvider>
  );
}
