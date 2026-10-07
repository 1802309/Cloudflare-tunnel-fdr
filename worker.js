export default {
  async fetch(request, env) {
    const target = new URL(env.TARGET_DOMAIN);
    const incoming = new URL(request.url);

    // مسیر و Query همان چیزی باشد که V2Box فرستاده
    target.pathname = incoming.pathname;
    target.search = incoming.search;

    // کپی Request برای ارسال به Origin
    const headers = new Headers(request.headers);

    // هدرهای IP مربوط به Cloudflare را حذف کن
    headers.delete("cf-connecting-ip");
    headers.delete("x-forwarded-for");
    headers.delete("x-real-ip");

    try {
      return await fetch(target.toString(), {
        method: request.method,
        headers,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : request.body,
      });
    } catch (err) {
      return new Response(
        `Origin error: ${err?.message || String(err)}`,
        { status: 502 }
      );
    }
  },
};