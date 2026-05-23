export default {
  async fetch(request) {
    const url = new URL(request.url);

    // فقط مسیر موردنظر
    if (url.pathname !== "/cdn-a8x29q") {
      return new Response("Not Found", { status: 404 });
    }

    // WebSocket check
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected WebSocket", { status: 400 });
    }

    // مقصد واقعی (origin)
    const target = "https://a.cdnconnect.site/cdn-a8x29q";

    // کل handshake را pass-through کن
    return fetch(target, {
      method: request.method,
      headers: request.headers,
    });
  }
};
