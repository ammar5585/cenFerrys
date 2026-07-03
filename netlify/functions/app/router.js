// Minimal exact-path router. The original PHP app used query strings
// for record ids (?booking_id=5, ?schedule_id=5) rather than path
// params, so plain exact-pathname matching per method is sufficient -
// no dynamic route segments are needed anywhere in this port.

export function createRouter() {
    const routes = new Map();

    function register(method, path, handler) {
        routes.set(`${method} ${path}`, handler);
    }

    return {
        get: (path, handler) => register('GET', path, handler),
        post: (path, handler) => register('POST', path, handler),

        async handle(request, ctx) {
            const url = new URL(request.url);
            // Trim a trailing slash (except root) so "/staff/book/" behaves like "/staff/book".
            let pathname = url.pathname.replace(/\/+$/, '') || '/';
            const key = `${request.method} ${pathname}`;
            const handler = routes.get(key);
            if (!handler) return null;
            return handler(request, ctx, url);
        },
    };
}
