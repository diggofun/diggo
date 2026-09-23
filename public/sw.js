/*
 * Diggo.fun push-only service worker.
 *
 * This file is served from the origin root because a subscription is bound to its scope, and it
 * deliberately registers no "fetch" handler: the app shell stays with the network and the CDN
 * cache, so this worker can never serve a stale bundle. Its whole job is to show the alert the
 * Worker sent and to put the player back on the right screen when they tap it.
 *
 * The payload is already-validated JSON produced by worker/push.ts (notificationMessage). Nothing
 * here decides anything about the game, and nothing here runs unless the player turned alerts on.
 */
"use strict";

const HOME_PATH = "/";

/** Only ever resolves to a same-origin path, so a malformed payload cannot redirect the tab. */
function safePath(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return HOME_PATH;
  try {
    const url = new URL(candidate, self.location.origin);
    if (url.origin !== self.location.origin) return HOME_PATH;
    return url.pathname + url.search + url.hash;
  } catch (_error) {
    return HOME_PATH;
  }
}

self.addEventListener("install", (event) => {
  // A waiting worker would miss pushes, and this worker owns no cache to be consistent with.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let message = {};
  if (event.data) {
    try {
      message = event.data.json();
    } catch (_error) {
      message = { body: event.data.text() };
    }
  }
  const title = typeof message.title === "string" && message.title.length > 0 ? message.title : "Diggo.fun";
  const body = typeof message.body === "string" ? message.body : "";
  const tag = typeof message.tag === "string" && message.tag.length > 0 ? message.tag : "diggo";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      tag: tag,
      renotify: false,
      data: { url: safePath(message.url) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = new URL(safePath(data.url), self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        try {
          if (new URL(client.url).origin !== self.location.origin) continue;
          await client.focus();
          if (typeof client.navigate === "function") await client.navigate(target);
          return;
        } catch (_error) {
          // Keep looking: a client that refuses focus is not a reason to open a second tab.
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});

/*
 * The push service rotated the endpoint. Re-registering needs a signed session, which this worker
 * does not have, so it asks any open tab to do it (src/push.ts, watchSubscriptionRotations). With
 * no tab open the old endpoint simply stops working and the next visit re-subscribes.
 */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) client.postMessage({ type: "diggo:push-subscription-change" });
    })(),
  );
});
