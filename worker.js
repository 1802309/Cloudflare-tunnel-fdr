export default {
  async fetch(request, env) {
    try {
      const TARGET = env.TARGET_DOMAIN;

      if (!TARGET) {
        return new Response("Missing TARGET_DOMAIN", { status: 500 });
      }

      const targetUrl = new URL(request.url);
      const base = new URL(TARGET);

      const url = new URL(
        targetUrl.pathname + targetUrl.search,
        base
      );

      const headers = new Headers(request.headers);

      headers.delete("host");

      const response = await fetch(url.toString(), {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD"
          ? undefined
          : request.body,
        redirect: "manual",
      });

      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });

    } catch (err) {
      return new Response("Worker Error: " + err.message, {
        status: 500,
      });
    }
  }
};
