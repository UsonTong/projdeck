// projdeck 的 Service Worker：推送通知、连不上电脑时的提示页。
// 不缓存接口和页面数据：数据都在电脑上，离线时没有意义，也避免看到过期的状态。
const CACHE = "projdeck-offline-v2";
const OFFLINE = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([OFFLINE])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

// 打开页面时：网络不通，或公网入口连不上电脑（隧道断开时 nginx 返回 502/504），显示提示页
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    (async () => {
      try {
        const res = await fetch(event.request);
        if (res.status === 502 || res.status === 503 || res.status === 504) return (await caches.match(OFFLINE)) ?? res;
        return res;
      } catch {
        return (await caches.match(OFFLINE)) ?? Response.error();
      }
    })(),
  );
});

self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || "projdeck", {
      body: data.body || "",
      tag: data.tag, // 同一个会话的新通知替换旧的
      renotify: true,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url || "/" },
    }),
  );
});

// 点通知：已经开着 projdeck 就切过去并打开对应会话，否则新开一个
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find((c) => new URL(c.url).origin === self.location.origin);
      if (existing) {
        // 先让页面打开会话，再切到前台：切前台失败（某些系统不允许）也不影响打开
        existing.postMessage({ type: "open", url });
        await existing.focus().catch(() => {});
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
