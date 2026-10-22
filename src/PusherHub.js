/**
 * PusherHub push notification + in-app messaging client for React Native,
 * on Android and iOS (see the note at the bottom of this file for iOS setup).
 *
 * Required setup (this is the whole "core" tier — everything else in this
 * file is optional):
 *
 *   import PusherHub from './PusherHub';
 *   await PusherHub.initialize({ appKey: '...', publicKey: '...', baseUrl: '...' });
 *   await PusherHub.registerDevice();
 *
 * You also need PusherHub.attachNotificationHandlers() called once, as early
 * as possible (e.g. at the top of index.js, before AppRegistry.registerComponent) —
 * see that function's own doc for why it can't just happen inside initialize().
 *
 * Optional: wrap your app in PusherHubMessageHost (also exported from this
 * file) to automatically fetch and display in-app messages on app open/
 * resume — the same bundled banner/modal/fullscreen/center_popup/
 * bottom_sheet rendering the Flutter SDK's PusherHubMessageHost widget and
 * the Kotlin/Java SDKs' checkForInAppMessages() provide, adapted to RN's
 * component model:
 *
 *   <PusherHubMessageHost>
 *     <App />
 *   </PusherHubMessageHost>
 *
 * This whole SDK is one file (this one) — drop it straight into your
 * project's source tree, e.g. src/PusherHub.js. Unlike the native Android
 * (Kotlin/Java) SDKs, this file's imports are resolved by your own
 * package.json — see the SDK Integration tab for the exact dependencies to
 * install (@react-native-firebase/app, @react-native-firebase/messaging,
 * @react-native-async-storage/async-storage, @notifee/react-native,
 * react-native-webview).
 *
 * Uses @react-native-firebase's newer "modular" API (getMessaging/getToken/
 * onMessage as standalone functions taking a messaging instance) rather
 * than the older `messaging()` namespaced default export — the default
 * export was removed in recent @react-native-firebase releases, so the
 * namespaced style silently resolves to undefined and every call throws
 * "is not a function".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Image,
  Linking,
  Modal,
  NativeModules,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  TurboModuleRegistry,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getApp } from '@react-native-firebase/app';
import {
  getMessaging,
  getToken,
  onTokenRefresh,
  onMessage,
  onNotificationOpenedApp,
  getInitialNotification,
  setBackgroundMessageHandler,
  registerDeviceForRemoteMessages,
  isDeviceRegisteredForRemoteMessages,
  getAPNSToken,
} from '@react-native-firebase/messaging';
import notifee, { AndroidImportance, AuthorizationStatus, EventType } from '@notifee/react-native';

const PREFS_KEY_ANONYMOUS_ID = 'pushhub_anonymous_id_v1';
// The signed-in user's ID from login() (or registerDevice(externalId)),
// kept across restarts until logout(): without it, the next launch's plain
// registerDevice() quietly turned the device anonymous again.
const PREFS_KEY_EXTERNAL_ID = 'pushhub_external_id';
// The last notification permission the backend accepted, so a foreground
// that found nothing changed costs nothing.
const PREFS_KEY_LAST_REPORTED_PERMISSION = 'pushhub_last_reported_notification_permission';
// The last FCM token the backend accepted. FCM rotates tokens without a
// reinstall; reporting the one being replaced lets the backend keep this
// install as the same device rather than counting a new install plus, later,
// an uninstall. Cleared with the app's data on reinstall, which is exactly
// when a new device row is the right answer.
const PREFS_KEY_LAST_REGISTERED_TOKEN = 'pushhub_last_registered_token';
const NOTIFICATION_CHANNEL_ID = 'pushhub_default';
// Matches the window the backend's Realtime tab buckets by. Anything faster
// just upserts the same minute row for no extra information.
const HEARTBEAT_INTERVAL_MS = 60000;

// The action PusherHub's backend hardcodes into every FCM payload's
// android.notification.click_action (a holdover from the original Flutter
// SDK, where it's required). Not used directly by this file (RN doesn't
// read Android's launch Intent action the way the native SDKs do), but
// AndroidManifest.xml still needs an <intent-filter> matching it — see the
// SDK Integration tab — or a background/killed-state notification tap
// won't relaunch this app at all.
const ACTION_NOTIFICATION_CLICK = 'FLUTTER_NOTIFICATION_CLICK';

let appKey = null;
let publicKey = null;
let baseUrl = null;
let onNotificationClick = null;
let initialized = false;

let currentToken = null;
let currentExternalId = null;
// Settles once registerDevice() has registered this launch's token, so
// PusherHubMessageHost's first check on app open waits for it rather than
// finding no token yet and skipping until the next resume.
let markRegistered;
const registered = new Promise((resolve) => {
  markRegistered = resolve;
});
// Settles once initialize() has run — for a tap that launched the app,
// which arrives first.
let markInitialized;
const initializedOnce = new Promise((resolve) => {
  markInitialized = resolve;
});
let appStateSubscription = null;
let tokenRefreshUnsubscribe = null;
let heartbeatTimer = null;

// Collected once (collectDeviceMetadata) and re-sent on every later
// registration — the backend's register-device endpoint replaces these
// fields wholesale, so omitting them on a later call would wipe out
// whatever was already stored server-side.
let deviceMetadata = {
  device: null,
  brand: null,
  version: null,
  language: null,
  country: null,
  timezone: null,
};

/** Lazily resolved — calling getMessaging() before the native Firebase app is ready would throw. */
function messagingInstance() {
  return getMessaging(getApp());
}

/**
 * Call once, as early as possible (e.g. your root App component's first
 * render, or index.js). There's deliberately no default for baseUrl — a
 * guessed one would silently point at the wrong server and
 * registerDevice() would fail with nothing obviously wrong in your own
 * code.
 *
 * @param {{appKey: string, publicKey: string, baseUrl: string, onNotificationClick?: (deepLink: string) => void}} config
 *   baseUrl: your PusherHub server's API base URL: "https://pusherhub.com/api"
 *   for apps on pusherhub.com — the dashboard's SDK Integration tab shows it
 *   filled in.
 *   onNotificationClick: optional — called instead of this SDK's default
 *   behavior (opening the link via Linking.openURL) when a tapped
 *   notification carries a deep link.
 */
async function initialize({ appKey: key, publicKey: pubKey, baseUrl: url, onNotificationClick: onClick } = {}) {
  appKey = key;
  publicKey = pubKey;
  baseUrl = url;
  onNotificationClick = onClick ?? null;
  initialized = true;
  markInitialized();

  if (Platform.OS === 'android') {
    await notifee.createChannel({
      id: NOTIFICATION_CHANNEL_ID,
      name: 'Notifications',
      importance: AndroidImportance.HIGH,
    });
  }
}

/**
 * Requests the FCM token and registers this device with the PusherHub
 * backend, as the user last signed in with login() — remembered across
 * restarts until logout() — or, with nobody signed in, a persistent
 * anonymous ID generated on first launch (matching OneSignal's default
 * anonymous-subscription behavior). Passing externalId here is the same as
 * calling login() with it.
 *
 * @param {string} [externalId]
 */
async function registerDevice(externalId) {
  if (!requireInitialized('registerDevice')) return;
  if (externalId != null) await AsyncStorage.setItem(PREFS_KEY_EXTERNAL_ID, externalId);

  await requestNotificationPermissionIfNeeded();

  // An iPhone gets an FCM token only once Apple's push service has given
  // the app its own (APNs) token — asked for sooner, getToken() fails.
  if (Platform.OS === 'ios' && !(await waitForApnsToken())) {
    console.warn(
      '[PusherHub] No APNs token from Apple — check the Push Notifications capability (aps-environment ' +
        'entitlement) and that your APNs key is uploaded in Firebase (see the SDK Integration tab).',
    );
    return;
  }

  let token;
  try {
    // Throws if Firebase isn't set up for this build (no
    // google-services.json / GoogleService-Info.plist, or the Firebase
    // setup not finished) — caught here so a missing/incomplete Firebase
    // setup logs a clear, actionable message instead of an unhandled
    // rejection.
    token = await getToken(messagingInstance());
  } catch (e) {
    console.warn(
      Platform.OS === 'ios'
        ? '[PusherHub] Failed to get an FCM token — check that GoogleService-Info.plist is in the app ' +
            '(see the SDK Integration tab).'
        : '[PusherHub] Failed to get an FCM token — check that google-services.json is present and the ' +
            'com.google.gms.google-services plugin is applied (see the SDK Integration tab).',
      e,
    );
    return;
  }

  currentToken = token;
  // Read now, not when registerDevice() was called: a login() or logout()
  // while the token was on its way counts.
  await registerToken(await resolvedExternalId(), token);
  markRegistered();
  observeTokenRefresh();
  observeAppState();
}

/**
 * iOS: registers for remote notifications (a no-op when
 * @react-native-firebase already did at launch) and waits up to 10 seconds
 * for Apple's APNs token, which FCM needs before it hands out its own.
 * False if it never came — no push entitlement, or no network.
 */
async function waitForApnsToken() {
  const messagingApp = messagingInstance();

  try {
    // @react-native-firebase registers at launch by itself unless an app
    // turned that off — and warns when asked again for nothing.
    if (!isDeviceRegisteredForRemoteMessages(messagingApp)) {
      await registerDeviceForRemoteMessages(messagingApp);
    }
  } catch (e) {
    console.warn('[PusherHub] Failed to register for remote notifications.', e);
    return false;
  }

  for (let attempt = 0; attempt < 40; attempt++) {
    if (await getAPNSToken(messagingApp)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/**
 * Re-registers whenever FCM rotates this device's token while the app is
 * running. Without it the backend kept sending to the dead token — every
 * notification to this device failed — until the next cold start happened
 * to call registerDevice() again. Subscribed once, however many times
 * registerDevice() is called.
 */
function observeTokenRefresh() {
  if (tokenRefreshUnsubscribe) return;

  tokenRefreshUnsubscribe = onTokenRefresh(messagingInstance(), async (newToken) => {
    currentToken = newToken;
    await registerToken(await resolvedExternalId(), newToken);
  });
}

/**
 * Aliases this device to a real signed-in user — equivalent to
 * `OneSignal.login(externalId)` — and remembers it on the device, so every
 * later launch registers as this user too, until logout(). Called before
 * registerDevice() has finished, the ID is still remembered and used as soon
 * as it does.
 */
async function login(externalId) {
  await AsyncStorage.setItem(PREFS_KEY_EXTERNAL_ID, externalId);
  if (!currentToken) return;
  await registerToken(externalId, currentToken);
}

/** Reverts this device back to its anonymous identity, and forgets the signed-in user — call this on sign-out. */
async function logout() {
  await AsyncStorage.removeItem(PREFS_KEY_EXTERNAL_ID);
  if (!currentToken) return;
  await registerToken(await getOrCreateAnonymousId(), currentToken);
}

/**
 * Optional: enriches this device's record with brand, model, app version,
 * language, country, and timezone — all read directly from the OS/JS
 * runtime, no permission needed. Unlike the Flutter/Kotlin/Java SDKs, this
 * does NOT resolve state/city via GPS — that needs a geolocation native
 * module this SDK deliberately doesn't bundle (keeping the required
 * dependency list short); add one yourself and pass state/city through a
 * custom register-device call if you need that level of targeting.
 *
 * Safe to call any time after registerDevice() has completed.
 */
async function collectDeviceMetadata() {
  if (!currentToken || !currentExternalId) {
    console.warn('[PusherHub] collectDeviceMetadata() called before registerDevice() completed.');
    return;
  }

  // Intl as the fallback: not every React Native build exposes
  // I18nManager through NativeModules.
  const locale =
    (NativeModules.I18nManager && NativeModules.I18nManager.localeIdentifier) ||
    Intl.DateTimeFormat().resolvedOptions().locale ||
    'en_US';
  const [language, country] = locale.replace('-', '_').split('_');
  // Core React Native gives no iPhone model name (that needs
  // react-native-device-info), so an iOS device is just "iPhone" or "iPad".
  const ios = Platform.OS === 'ios';

  deviceMetadata = {
    device: ios ? (Platform.constants?.interfaceIdiom === 'pad' ? 'iPad' : 'iPhone') : (Platform.constants?.Model ?? null),
    brand: ios ? 'Apple' : (Platform.constants?.Brand ?? Platform.constants?.Manufacturer ?? null),
    // App version isn't exposed by core RN/Platform — install
    // react-native-device-info and set this from getVersion() yourself if
    // you need it; left null here to keep this SDK's dependency list short.
    version: null,
    language: language ?? null,
    country: country ?? null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
  };

  await registerToken(currentExternalId, currentToken);
}

/**
 * Fetches the in-app messages currently eligible for this device — active,
 * within their display window, matching this device's audience, and not
 * already shown once (for messages set to display only once). This SDK
 * only fetches and tracks these — it doesn't include a bundled rendering
 * UI (unlike the Flutter SDK's PusherHubMessageHost, or the Kotlin/Java
 * SDKs' checkForInAppMessages) — build your own banner/modal from this
 * data, then report trackInAppShown/trackInAppClick/trackInAppDismiss
 * yourself as appropriate.
 *
 * @returns {Promise<Array<object>>}
 */
async function fetchInAppMessages() {
  if (!currentToken) {
    console.warn('[PusherHub] Skipping fetchInAppMessages — no FCM token registered yet.');
    return [];
  }

  try {
    const response = await postJson(`${baseUrl}/fetch-in-app-messages`, {
      app_key: appKey,
      token: currentToken,
    });
    return response?.messages ?? [];
  } catch (e) {
    console.warn('[PusherHub] Error fetching in-app messages', e);
    return [];
  }
}

/** Reports that `message` was actually displayed to the user. */
function trackInAppShown(message) {
  return trackInAppEvent('track-in-app-shown', message.id);
}

/** Reports that the user tapped `message`'s button. */
function trackInAppClick(message) {
  return trackInAppEvent('track-in-app-click', message.id);
}

/** Reports that `message` was closed without the button being tapped. */
function trackInAppDismiss(message) {
  return trackInAppEvent('track-in-app-dismiss', message.id);
}

async function trackInAppEvent(endpoint, inAppMessageId) {
  if (!currentToken) {
    console.warn(`[PusherHub] Skipping ${endpoint} — no FCM token registered yet.`);
    return;
  }
  try {
    await postJson(`${baseUrl}/${endpoint}`, {
      app_key: appKey,
      in_app_message_id: inAppMessageId,
      token: currentToken,
    });
  } catch (e) {
    console.warn(`[PusherHub] Failed to send ${endpoint}`, e);
  }
}

// ---------------------------------------------------------------------
// Notification receiving/display/tap-tracking.
//
// Unlike the native Android SDKs (which register a single
// FirebaseMessagingService and handle everything from there), React
// Native's Firebase + notifee libraries split this across several
// separate listeners depending on what state the app was in when the
// notification arrived and when it was tapped. attachNotificationHandlers()
// wires all of them to the same two behaviors: build+show a system
// notification while foregrounded (the OS does this automatically while
// backgrounded/killed, matching the native SDKs' behavior), and report
// open/click + follow the deep link on any tap, from any state.
// ---------------------------------------------------------------------

/**
 * Call this once, as early as possible — e.g. at the very top of
 * index.js, before AppRegistry.registerComponent() — NOT inside a
 * component's useEffect(). setBackgroundMessageHandler() only reliably
 * catches background/killed-state messages if it's registered outside the
 * React tree's lifecycle, before the app finishes launching.
 *
 * initialize() itself doesn't call this for you, since index.js (not
 * App.js) is the correct place for it and this SDK can't control where
 * it's imported from.
 */
function attachNotificationHandlers() {
  const messagingApp = messagingInstance();

  // Background/quit-state DATA-ONLY messages (no "notification" block) —
  // for a combined notification+data message, which is what PusherHub
  // always sends, Android displays the system notification itself here
  // without calling any JS at all, so this mainly exists so
  // react-native-firebase doesn't warn about a missing handler.
  setBackgroundMessageHandler(messagingApp, async () => {});

  // Foreground messages — Android does NOT auto-display a notification in
  // this state, so build one ourselves with notifee (same as the native
  // SDKs' explicit NotificationCompat.Builder call).
  onMessage(messagingApp, async (remoteMessage) => {
    await showNotification(remoteMessage);
  });

  // Tap on the OS-auto-displayed notification while the app was in the
  // background (not killed).
  onNotificationOpenedApp(messagingApp, (remoteMessage) => {
    handleNotificationOpened(remoteMessage?.data ?? {});
  });

  // Tap on the OS-auto-displayed notification that (re)launched the app
  // from a fully killed state.
  getInitialNotification(messagingApp).then((remoteMessage) => {
    if (remoteMessage) handleNotificationOpened(remoteMessage.data ?? {});
  });

  // Tap on a notifee-created notification (the foreground path above)
  // while the app is in the foreground or background.
  notifee.onForegroundEvent(({ type, detail }) => {
    if (type === EventType.PRESS) handleNotificationOpened(detail.notification?.data ?? {});
  });
  notifee.onBackgroundEvent(async ({ type, detail }) => {
    if (type === EventType.PRESS) handleNotificationOpened(detail.notification?.data ?? {});
  });

  // Tap on a notifee-created notification that (re)launched the app from
  // a fully killed state.
  notifee.getInitialNotification().then((initial) => {
    if (initial) handleNotificationOpened(initial.notification?.data ?? {});
  });
}

async function showNotification(remoteMessage) {
  // title/body live on remoteMessage.notification, not .data — PusherHub's
  // backend always sends both a notification and a data block (see
  // FcmService::deliver() server-side); notification_id/deep_link (used
  // for tap tracking, see handleNotificationOpened) live on .data.
  // On an iPhone FCM passes the notification's image along as fcmOptions.image.
  const iosImage = remoteMessage.fcmOptions?.image;

  await notifee.displayNotification({
    title: remoteMessage.notification?.title,
    body: remoteMessage.notification?.body,
    android: {
      channelId: NOTIFICATION_CHANNEL_ID,
      pressAction: { id: 'default' },
    },
    ios: {
      sound: 'default',
      // Shown as a banner even though the app is open, as on Android.
      foregroundPresentationOptions: { banner: true, list: true, sound: true, badge: true },
      ...(iosImage ? { attachments: [{ url: iosImage }] } : {}),
    },
    data: remoteMessage.data ?? {},
  });
}

async function handleNotificationOpened(data) {
  const notificationId = data?.notification_id;
  const deepLink = data?.deep_link;
  if (!notificationId) return;

  trackEvent('track-open', notificationId);
  if (deepLink) {
    trackEvent('track-click', notificationId);
    // A tap that launched the app comes before initialize(), which brings
    // the app's own onNotificationClick, if it has one.
    await initializedOnce;
    openDeepLink(deepLink);
  }
}

function openDeepLink(deepLink) {
  if (onNotificationClick) {
    onNotificationClick(deepLink);
    return;
  }
  Linking.openURL(deepLink).catch((e) => console.warn(`[PusherHub] No handler available to open deep link: ${deepLink}`, e));
}

async function trackEvent(endpoint, notificationId) {
  // A tap that launched the app arrives before initialize() and
  // registerDevice() have run, and was lost: once initialized, report it
  // with the token the backend took last time; before that, or with none
  // saved yet, wait for this launch's registration.
  let token = currentToken;
  if (!token && initialized) token = await AsyncStorage.getItem(PREFS_KEY_LAST_REGISTERED_TOKEN);
  if (!token) {
    await registered;
    token = currentToken;
  }
  if (!token) {
    console.warn(`[PusherHub] Skipping ${endpoint} — no FCM token registered yet.`);
    return;
  }
  try {
    await postJson(`${baseUrl}/${endpoint}`, {
      app_key: appKey,
      notification_id: Number.isNaN(Number(notificationId)) ? notificationId : Number(notificationId),
      token,
    });
  } catch (e) {
    console.warn(`[PusherHub] Failed to send ${endpoint}`, e);
  }
}

async function registerToken(externalId, token) {
  const permission = await notificationPermissionStatus();
  const previousToken = await AsyncStorage.getItem(PREFS_KEY_LAST_REGISTERED_TOKEN);
  try {
    const response = await postJson(`${baseUrl}/register-device`, {
      app_key: appKey,
      external_id: externalId,
      token,
      // Covers both ways a rotation arrives: onTokenRefresh while running,
      // and getToken() returning a different token on a later launch.
      ...(previousToken && previousToken !== token ? { previous_token: previousToken } : {}),
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      device: deviceMetadata.device,
      brand: deviceMetadata.brand,
      version: deviceMetadata.version,
      language: deviceMetadata.language,
      country: deviceMetadata.country,
      timezone: deviceMetadata.timezone,
      notification_permission: permission,
    });
    if (response) {
      currentExternalId = externalId;
      // Only cached once the backend has actually taken it — caching a value
      // a failed request never delivered would suppress the retry on the
      // next foreground. The token likewise: if this request failed, the
      // next attempt must still report the old token as the one replaced.
      await AsyncStorage.setItem(PREFS_KEY_LAST_REPORTED_PERMISSION, permission);
      await AsyncStorage.setItem(PREFS_KEY_LAST_REGISTERED_TOKEN, token);
      console.log('[PusherHub] Device registered successfully.');
    }
  } catch (e) {
    console.warn('[PusherHub] Failed to register device.', e);
  }
}

/** Returns the parsed JSON response body, or throws on any failure (network, non-2xx, bad JSON). */
async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${publicKey}`,
      // Harmless against a real server; needed only when baseUrl points at
      // a free-tier ngrok tunnel — without it, ngrok returns an HTML
      // "visit site" warning page instead of forwarding to PusherHub.
      'ngrok-skip-browser-warning': 'true',
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${url} failed: HTTP ${response.status} ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

/** Who this device registers as: the signed-in user (see login()), or the anonymous ID. */
async function resolvedExternalId() {
  return (await AsyncStorage.getItem(PREFS_KEY_EXTERNAL_ID)) ?? (await getOrCreateAnonymousId());
}

async function getOrCreateAnonymousId() {
  const existing = await AsyncStorage.getItem(PREFS_KEY_ANONYMOUS_ID);
  if (existing) return existing;

  const id = generateUuid();
  await AsyncStorage.setItem(PREFS_KEY_ANONYMOUS_ID, id);
  return id;
}

// No extra dependency for this — a real UUID library isn't needed just to
// generate a random per-install identifier.
function generateUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function requireInitialized(methodName) {
  if (!initialized) {
    console.error(`[PusherHub] PusherHub.initialize() must be called before ${methodName}().`);
  }
  return initialized;
}

async function requestNotificationPermissionIfNeeded() {
  // Deliberately notifee's requestPermission(), not messaging's — the
  // Firebase Messaging module's requestPermission() is iOS-focused
  // (@react-native-firebase's own docs mark it deprecated for exactly this
  // reason) and does NOT reliably trigger Android 13+'s POST_NOTIFICATIONS
  // runtime prompt, silently leaving notifications undeliverable with no
  // error anywhere. notifee's version correctly handles both platforms —
  // a no-op below API 33 on Android, where the permission doesn't exist
  // and notifications just work.
  await notifee.requestPermission();
}

/**
 * This device's notification permission as the backend records it:
 * 'granted', 'denied', or 'not_determined'.
 *
 * Read fresh from the OS on every call rather than cached from the
 * registerDevice() prompt, so a user who flips the setting in iOS/Android
 * system settings long afterwards is reported accurately. notifee's
 * getNotificationSettings() (not messaging's) for the same reason
 * requestPermission() uses it — it reports Android correctly.
 *
 * Android caveat: notifee only ever reports AUTHORIZED or DENIED there, so a
 * fresh Android 13+ install that hasn't been prompted yet reads as 'denied'
 * rather than 'not_determined'. The native Kotlin/Java SDKs distinguish the
 * two; this one can't, and reporting the stricter of the two is the safer
 * inaccuracy — it never claims someone opted in who didn't.
 */
async function notificationPermissionStatus() {
  try {
    const { authorizationStatus } = await notifee.getNotificationSettings();

    switch (authorizationStatus) {
      // Provisional is iOS quiet delivery — notifications do arrive, which
      // is what's being asked.
      case AuthorizationStatus.AUTHORIZED:
      case AuthorizationStatus.PROVISIONAL:
        return 'granted';
      case AuthorizationStatus.DENIED:
        return 'denied';
      case AuthorizationStatus.NOT_DETERMINED:
        return 'not_determined';
      default:
        return 'not_determined';
    }
  } catch (e) {
    console.warn('[PusherHub] Failed to read notification permission.', e);
    return 'not_determined';
  }
}

/**
 * Re-reports the notification permission when it no longer matches what the
 * backend was last told — the user turning notifications off (or back on) in
 * system settings weeks later, which produces no callback of any kind.
 *
 * A no-op with no network call in the overwhelmingly common case where
 * nothing changed, so it's safe on every foreground.
 */
async function syncNotificationPermissionIfChanged() {
  if (!currentToken) return;

  const permission = await notificationPermissionStatus();
  if (permission === (await AsyncStorage.getItem(PREFS_KEY_LAST_REPORTED_PERMISSION))) return;

  await registerToken(await resolvedExternalId(), currentToken);
}

/**
 * Tells the backend this device has the app open right now — the signal
 * behind the dashboard's Realtime tab, and the only thing separating "using
 * the app" from registerDevice()'s "launched it at some point".
 *
 * Silently skipped before registration completes; the next tick picks it up
 * once a token exists.
 */
async function sendHeartbeat() {
  if (!currentToken) return;

  try {
    await postJson(`${baseUrl}/heartbeat`, { app_key: appKey, token: currentToken });
  } catch (e) {
    // A dropped heartbeat only costs one minute of Realtime resolution —
    // never worth surfacing to the host app.
  }
}

function startHeartbeat() {
  stopHeartbeat();
  sendHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

/**
 * Watches the app move between foreground and background: re-reports a
 * notification permission changed in system settings while away, and runs
 * the Realtime heartbeat only while the app is actually on screen. Needs
 * nothing from the host app.
 */
function observeAppState() {
  if (appStateSubscription) return;

  startHeartbeat();

  appStateSubscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      syncNotificationPermissionIfChanged();
      startHeartbeat();
      return;
    }

    // 'background' and iOS's 'inactive' both mean the app is no longer the
    // thing the user is looking at.
    stopHeartbeat();
  });
}

// ---------------------------------------------------------------------
// In-app message rendering — the native equivalent of the Flutter SDK's
// PusherHubMessageHost widget, and of the Kotlin/Java SDKs'
// checkForInAppMessages(). Built with core React Native components plus
// react-native-webview (for "html" content mode) — no image-loading
// library, using RN's own <Image>.
// ---------------------------------------------------------------------

function colorOrDefault(hex, fallback) {
  return hex && String(hex).trim() ? hex : fallback;
}

function handleBlockClick(block, onAction) {
  const clickAction = block.click_action || {};
  if ((clickAction.type === 'open_url' || clickAction.type === 'deep_link') && clickAction.value) {
    onAction({ type: 'openUrl', url: clickAction.value });
  } else if (clickAction.type === 'close') {
    onAction({ type: 'close' });
  }
}

// RN's <Image>, unlike a web <img> or Flutter's Image.network, has no
// built-in "size to the image's own aspect ratio" behavior — it needs an
// explicit height (or aspectRatio) or it renders at 0 height. Image.getSize()
// fetches the real dimensions once, and aspectRatio + resizeMode="contain"
// then shows the whole image with no cropping — matching the dashboard
// preview's <img class="w-full"> (also uncropped) instead of the fixed-height
// crop this used before.
function NoCropImage({ uri, style }) {
  const [aspectRatio, setAspectRatio] = useState(1);

  useEffect(() => {
    let cancelled = false;
    Image.getSize(
      uri,
      (width, height) => {
        if (!cancelled && width > 0 && height > 0) setAspectRatio(width / height);
      },
      () => {}, // Leave the 1:1 fallback in place — a failed size lookup shouldn't block the image itself from attempting to load.
    );
    return () => {
      cancelled = true;
    };
  }, [uri]);

  return <Image source={{ uri }} style={[style, { aspectRatio }]} resizeMode="contain" />;
}

function SimpleContent({ message, textColor, onAction }) {
  return (
    <>
      {!!message.image && <NoCropImage uri={message.image} style={styles.simpleImage} />}
      {!!message.heading && <Text style={[styles.heading, { color: textColor }]}>{message.heading}</Text>}
      {!!message.body && <Text style={[styles.body, { color: textColor }]}>{message.body}</Text>}
      {!!message.button_text && (
        <TouchableOpacity
          style={styles.simpleButton}
          onPress={() =>
            onAction(message.button_deep_link ? { type: 'openUrl', url: message.button_deep_link } : { type: 'close' })
          }
        >
          <Text style={styles.simpleButtonText}>{message.button_text}</Text>
        </TouchableOpacity>
      )}
    </>
  );
}

function BlocksContent({ blocks, textColor, onAction }) {
  return (
    <>
      {(blocks || []).map((block, index) => {
        if (block.type === 'text') {
          return (
            <Text
              key={index}
              style={[
                styles.blockText,
                {
                  color: colorOrDefault(block.color, textColor),
                  fontSize: typeof block.font_size === 'number' ? block.font_size : 16,
                  fontWeight: block.bold ? 'bold' : 'normal',
                  fontStyle: block.italic ? 'italic' : 'normal',
                  textDecorationLine: block.underline ? 'underline' : 'none',
                  textAlign: block.align === 'left' ? 'left' : block.align === 'right' ? 'right' : 'center',
                },
              ]}
            >
              {block.text || ''}
            </Text>
          );
        }
        if (block.type === 'image' && block.image) {
          return (
            <TouchableOpacity key={index} onPress={() => handleBlockClick(block, onAction)}>
              <NoCropImage uri={block.image} style={styles.blockImage} />
            </TouchableOpacity>
          );
        }
        if (block.type === 'button') {
          return (
            <TouchableOpacity
              key={index}
              style={[
                styles.blockButton,
                {
                  backgroundColor: colorOrDefault(block.background_color, '#051B2C'),
                  borderRadius: typeof block.corner_radius === 'number' ? block.corner_radius : 8,
                },
              ]}
              onPress={() => handleBlockClick(block, onAction)}
            >
              <Text style={{ color: colorOrDefault(block.font_color, '#FFFFFF') }}>{block.text || 'Button'}</Text>
            </TouchableOpacity>
          );
        }
        return null;
      })}
    </>
  );
}

/**
 * A WebView pre-wired with the same PushHubIamApi JavaScript bridge
 * documented on the dashboard's HTML in-app message editor —
 * PushHubIamApi.close(), .openUrl(url), and .trackClick() all work exactly
 * as an admin authoring HTML content there expects.
 */
function HtmlContent({ message, onAction }) {
  const bridge = `
    window.PushHubIamApi = {
      close: function () { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'close' })); },
      openUrl: function (url) { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'openUrl', url: url })); },
      trackClick: function () { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'trackClick' })); }
    };
    true;
  `;
  return (
    <WebView
      originWhitelist={['*']}
      source={{ html: message.html_content || '' }}
      injectedJavaScriptBeforeContentLoaded={bridge}
      onMessage={(event) => {
        try {
          const payload = JSON.parse(event.nativeEvent.data);
          if (payload.type === 'close') onAction({ type: 'close' });
          else if (payload.type === 'openUrl') onAction({ type: 'openUrl', url: payload.url });
          else if (payload.type === 'trackClick') onAction({ type: 'trackClick' });
        } catch (e) {
          // Ignore malformed bridge messages.
        }
      }}
      style={styles.webview}
    />
  );
}

/**
 * How far the screen's own bars reach in, since a message's Modal covers the
 * whole screen, bars included. Core React Native has no safe-area API and
 * this SDK adds no dependency for one: Android reports its status bar's
 * height; on an iPhone the status bar's height stands in for the top inset,
 * and a tall one (the Face ID models' notch or Dynamic Island) means a home
 * indicator along the bottom too.
 */
function screenInsets() {
  if (Platform.OS === 'android') return { top: StatusBar.currentHeight ?? 0, bottom: 0 };

  let height = 0;
  try {
    const statusBarManager = TurboModuleRegistry.get('StatusBarManager') ?? NativeModules.StatusBarManager;
    height = statusBarManager?.getConstants?.().HEIGHT ?? 0;
  } catch {
    height = 0;
  }
  return { top: height, bottom: height >= 44 ? 34 : 0 };
}

/**
 * onExplicitClose fires for a user action that counts as "acted on" —
 * the close (✕) button, or a button/block with no deep link — none of
 * which should also report a dismiss. onImplicitDismiss fires for
 * everything else that hides the message (backdrop tap, the system back
 * button) — these DO report a dismiss. This mirrors the Kotlin/Java SDKs'
 * showInAppMessage(), where `actedOn` is set for both its Close and
 * OpenUrl branches, and only an untouched dialog dismissal reports
 * trackInAppDismiss.
 */
function InAppMessageOverlay({ message, onExplicitClose, onImplicitDismiss, onDeepLink }) {
  const isFullscreen = message.type === 'fullscreen';
  const textColor = colorOrDefault(message.text_color, '#0F172A');
  const insets = screenInsets();
  const cardPadding = message.content_mode === 'html' ? 0 : typeof message.padding === 'number' ? message.padding : 16;

  const handleAction = (action) => {
    if (action.type === 'close') {
      onExplicitClose();
    } else if (action.type === 'openUrl') {
      onDeepLink(action.url);
    } else if (action.type === 'trackClick') {
      trackInAppClick(message);
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onImplicitDismiss} statusBarTranslucent>
      <View
        style={[
          styles.overlayContainer,
          {
            justifyContent: message.type === 'banner' ? 'flex-start' : message.type === 'bottom_sheet' ? 'flex-end' : 'center',
            padding: isFullscreen ? 0 : 8,
            // Clear of the status bar (and an iPhone's notch or Dynamic
            // Island) at the top, and of the home indicator at the bottom.
            ...(message.type === 'banner' ? { paddingTop: 8 + insets.top } : {}),
            ...(message.type === 'bottom_sheet' ? { paddingBottom: 8 + insets.bottom } : {}),
          },
        ]}
      >
        {!isFullscreen && (
          <TouchableWithoutFeedback onPress={onImplicitDismiss}>
            <View style={StyleSheet.absoluteFill} />
          </TouchableWithoutFeedback>
        )}
        <View
          style={[
            styles.card,
            {
              backgroundColor: colorOrDefault(message.background_color, '#FFFFFF'),
              borderRadius: isFullscreen ? 0 : 16,
              padding: cardPadding,
              // A full-screen message keeps its content between the bars.
              ...(isFullscreen ? { paddingTop: cardPadding + insets.top, paddingBottom: cardPadding + insets.bottom } : {}),
            },
            isFullscreen && styles.cardFullscreen,
          ]}
        >
          {!!message.background_image && (
            <Image source={{ uri: message.background_image }} style={StyleSheet.absoluteFill} />
          )}
          {message.content_mode === 'html' && message.html_content ? (
            <HtmlContent message={message} onAction={handleAction} />
          ) : message.content_mode === 'blocks' ? (
            <BlocksContent blocks={message.blocks} textColor={textColor} onAction={handleAction} />
          ) : (
            <SimpleContent message={message} textColor={textColor} onAction={handleAction} />
          )}
          {message.show_close_button !== false && (
            <TouchableOpacity style={[styles.closeButton, isFullscreen && { top: 4 + insets.top }]} onPress={onExplicitClose}>
              <Text style={{ color: textColor, fontSize: 16 }}>✕</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </Modal>
  );
}

/**
 * Wrap your app in this to automatically fetch and display in-app
 * messages on app open/resume — the same content an admin authors on the
 * PusherHub dashboard, rendered for you:
 *
 *   <PusherHubMessageHost>
 *     <App />
 *   </PusherHubMessageHost>
 *
 * Prefer full control over the UI instead? Call PusherHub.fetchInAppMessages()
 * and build your own from the raw data, then report
 * trackInAppShown/trackInAppClick/trackInAppDismiss yourself.
 */
function PusherHubMessageHost({ children }) {
  const [message, setMessage] = useState(null);
  const actedOnRef = useRef(false);
  const dismissTimerRef = useRef(null);

  const clearDismissTimer = () => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
  };

  const checkForMessages = useCallback(async () => {
    // On app open this runs before registerDevice() has a token; wait for it.
    await registered;
    const messages = await fetchInAppMessages();
    if (messages.length === 0) return;

    const next = messages[0];
    actedOnRef.current = false;
    setMessage(next);
    trackInAppShown(next);

    if (next.dismiss_after_seconds && next.dismiss_after_seconds > 0) {
      clearDismissTimer();
      // An auto-timeout is an implicit dismiss, same as a backdrop tap —
      // still reports trackInAppDismiss if nothing else acted on it first
      // (matches the Kotlin/Java SDKs, whose auto-dismiss timer just calls
      // dialog.dismiss(), running through the same dismiss-listener check).
      dismissTimerRef.current = setTimeout(() => {
        setMessage((current) => {
          if (current === next && !actedOnRef.current) trackInAppDismiss(current);
          return current === next ? null : current;
        });
      }, next.dismiss_after_seconds * 1000);
    }
  }, []);

  useEffect(() => {
    checkForMessages();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') checkForMessages();
    });
    return () => {
      subscription.remove();
      clearDismissTimer();
    };
  }, [checkForMessages]);

  // Close (✕) button, or a button/block with no deep link — "acted on",
  // does not also report a dismiss.
  const handleExplicitClose = useCallback(() => {
    actedOnRef.current = true;
    setMessage(null);
    clearDismissTimer();
  }, []);

  // Backdrop tap or the system back button — genuinely dismissed without
  // the user acting on the message.
  const handleImplicitDismiss = useCallback(() => {
    setMessage((current) => {
      if (current && !actedOnRef.current) trackInAppDismiss(current);
      return null;
    });
    clearDismissTimer();
  }, []);

  const handleDeepLink = useCallback(
    (url) => {
      actedOnRef.current = true;
      if (message) trackInAppClick(message);
      openDeepLink(url);
      setMessage(null);
      clearDismissTimer();
    },
    [message],
  );

  return (
    <>
      {children}
      {message && (
        <InAppMessageOverlay
          message={message}
          onExplicitClose={handleExplicitClose}
          onImplicitDismiss={handleImplicitDismiss}
          onDeepLink={handleDeepLink}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  overlayContainer: {
    flex: 1,
    alignItems: 'stretch',
  },
  card: {
    overflow: 'hidden',
  },
  cardFullscreen: {
    flex: 1,
    justifyContent: 'center',
  },
  closeButton: {
    position: 'absolute',
    top: 4,
    right: 4,
    padding: 12,
  },
  simpleImage: {
    width: '100%',
    borderRadius: 8,
    marginBottom: 8,
  },
  heading: {
    fontSize: 18,
    fontWeight: 'bold',
    marginTop: 8,
  },
  body: {
    fontSize: 14,
    opacity: 0.85,
    marginTop: 4,
  },
  simpleButton: {
    marginTop: 12,
    backgroundColor: '#051B2C',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  simpleButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  blockText: {
    marginTop: 4,
    marginBottom: 4,
  },
  blockImage: {
    width: '100%',
    marginTop: 4,
    marginBottom: 4,
    borderRadius: 8,
  },
  blockButton: {
    marginTop: 4,
    paddingVertical: 10,
    alignItems: 'center',
  },
  webview: {
    minHeight: 200,
  },
});

const PusherHub = {
  initialize,
  attachNotificationHandlers,
  registerDevice,
  login,
  logout,
  collectDeviceMetadata,
  fetchInAppMessages,
  trackInAppShown,
  trackInAppClick,
  trackInAppDismiss,
  get externalId() {
    return currentExternalId;
  },
};

export default PusherHub;
export { PusherHubMessageHost };

// iOS note: the code here covers both platforms — registerDevice() waits
// for Apple's APNs token before asking FCM for one, and reports the device
// as 'ios'. What it can't do from JavaScript is the app's own setup: the
// Push Notifications capability and Background Modes > Remote
// notifications in Xcode (an Expo app: aps-environment and
// UIBackgroundModes in app.json), GoogleService-Info.plist, dynamic
// frameworks in the Podfile, and the APNs key uploaded in Firebase — see the
// SDK Integration tab. Images in notifications that arrive while the app is
// closed need the Notification Service Extension from that tab too.
