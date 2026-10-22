# PusherHub React Native SDK

Push notifications and in-app messages for your React Native app on **Android and iOS**, sent through your own Firebase project with [PusherHub](https://pusherhub.com).

[Website](https://pusherhub.com) · [Guides](https://pusherhub.com/docs) · [Pricing](https://pusherhub.com/pricing)

## What it does

- Registers each phone with PusherHub and keeps its FCM token up to date
- Links a phone to your own user id with `login()` — remembered across restarts until `logout()`
- Shows a notification while your app is open, and reports opens and clicks
- Shows in-app messages (banner, modal, full screen, center popup, bottom sheet) with `PusherHubMessageHost`
- Optional device details (brand, model, app version, language, country, time zone)

The SDK is a single file, [`src/PusherHub.js`](src/PusherHub.js).

## Before you start

1. A PusherHub account with your app added — it's free to start at [pusherhub.com](https://pusherhub.com).
2. Your app added to a Firebase project for Android and/or iOS, with the Firebase service account key uploaded to your app in PusherHub. See the [getting-started guide](https://pusherhub.com/docs/getting-started).
3. Your **app key** and **public key** — on your app's **SDK Integration** tab in PusherHub, which also shows every step below with your keys filled in.

## Install

1. Add the dependencies:

   ```bash
   npm install @react-native-firebase/app @react-native-firebase/messaging \
       @react-native-async-storage/async-storage @notifee/react-native \
       react-native-webview
   ```

   `react-native-webview` is only needed for HTML in-app messages.

2. Copy [`src/PusherHub.js`](src/PusherHub.js) into your project's `src/` folder.

3. Finish the Firebase setup for Android and iOS (Google services files; on Android the `POST_NOTIFICATIONS` permission and the notification-tap intent filter) — see your app's SDK Integration tab or the [guides](https://pusherhub.com/docs).

## Quick start

`index.js` — attach the notification handlers before your app starts:

```js
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import PusherHub from './src/PusherHub';

PusherHub.attachNotificationHandlers();

AppRegistry.registerComponent(appName, () => App);
```

`App.tsx`:

```jsx
import { useEffect } from 'react';
import PusherHub, { PusherHubMessageHost } from './src/PusherHub';

function App() {
  useEffect(() => {
    (async () => {
      await PusherHub.initialize({
        appKey: 'YOUR_APP_KEY',
        publicKey: 'YOUR_PUBLIC_KEY',
        baseUrl: 'https://pusherhub.com/api',
      });

      // Required: registers this phone.
      await PusherHub.registerDevice();

      // Optional: brand, model, app version, language, country, time zone.
      await PusherHub.collectDeviceMetadata();
    })();
  }, []);

  return (
    // Optional: shows in-app messages on app open.
    <PusherHubMessageHost>
      {/* ...your app... */}
    </PusherHubMessageHost>
  );
}

export default App;
```

## Signed-in users

```js
await PusherHub.login(currentUserId);   // when someone signs in
await PusherHub.logout();               // when they sign out
```

## Keys

The **public key** is meant to be built into your app. Never put your **secret key** in an app — it's only for your own server, with PusherHub's REST API.

## Help

- Step-by-step guides: [pusherhub.com/docs](https://pusherhub.com/docs)
- Your app's **SDK Integration** tab in PusherHub has every step with your keys filled in.

## License

[MIT](LICENSE)
