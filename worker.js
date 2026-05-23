export default {
  async fetch(request, env) {
    try {
      const TARGET = env.TARGET_DOMAIN;

      if (!TARGET) {
        return new Response("Missing TARGET_DOMAIN", { status: 500 });
      }

      const url = new URL(request.url);

      // فقط این مسیر را قبول کن
      const PATH = "/cdn-a8x29q";

      if (!url.pathname.startsWith(PATH)) {
        return new Response("Not Found", { status: 404 });
      }

      const origin = new URL(TARGET);

      // مسیر + query کامل منتقل می‌شود
      const targetUrl =
        origin.origin +
        url.pathname +
        url.search;

      const headers = new Headers(request.headers);

      // حذف header های مشکل‌ساز
      headers.delete("host");
      headers.delete("cf-connecting-ip");
      headers.delete("cf-ray");

      const response = await fetch(targetUrl, {
        method: request.method,
        headers,
        body:
          request.method === "GET" || request.method === "HEAD"
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
