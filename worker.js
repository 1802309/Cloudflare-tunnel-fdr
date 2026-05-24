export default {
  async fetch(request, env) {
    const TARGET = (env.TARGET_DOMAIN || "").replace(/\/$/, "");
    
    if (!TARGET) {
      return new Response("Missing TARGET_DOMAIN", { status: 500 });
    }

    const url = new URL(request.url);
    const targetUrl = TARGET + url.pathname + url.search;

    return fetch(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
  }
};
