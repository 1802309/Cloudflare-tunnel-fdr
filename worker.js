export default {
  async fetch(request, env) {
    const TARGET_BASE = (env.TARGET_DOMAIN || "").replace(/\/$/, "");

    if (!TARGET_BASE) {
      return new Response("Missing TARGET_DOMAIN", {
        status: 500,
      });
    }

    const incomingUrl = new URL(request.url);

    // optional path protection
    if (!incomingUrl.pathname.startsWith("/cdn-a8x29q")) {
      return new Response("Not Found", { status: 404 });
    }

    const targetUrl =
      TARGET_BASE +
      incomingUrl.pathname +
      incomingUrl.search;

    const headers = new Headers(request.headers);

    headers.delete("host");
    headers.delete("cf-connecting-ip");
    headers.delete("x-forwarded-for");

    headers.set(
      "host",
      new URL(TARGET_BASE).hostname
    );

    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body:
        request.method === "GET" ||
        request.method === "HEAD"
          ? undefined
          : request.body,
      redirect: "manual",
    });

    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  },
};
