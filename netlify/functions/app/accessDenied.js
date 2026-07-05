// Styled "Access Denied" page for a permission-gated route, rendered
// through the same authenticated shell as every other page (so the
// user's own sidebar/navbar still show and their reissued session
// cookie is still attached - unlike response.js's plain forbidden(),
// which returns bare unstyled HTML with no chrome and silently drops
// auth.setCookie, meaning a 403'd request never actually refreshed the
// session it just verified).

import { html } from './templates/html.js';
import { renderShellForRequest } from './shellHelper.js';

export async function accessDeniedResponse({ request, auth, pageTitle }) {
    const body = html`
<div class="text-center py-5">
  <i class="bi bi-shield-lock display-1 text-danger" aria-hidden="true"></i>
  <h3 class="mt-3">Access Denied</h3>
  <p class="text-muted">You do not have permission to view this page.</p>
  <a href="/dashboard" class="btn btn-primary mt-2">Return to Dashboard</a>
</div>`;

    const response = await renderShellForRequest({
        request,
        auth,
        pageTitle: pageTitle || 'Access Denied',
        path: new URL(request.url).pathname,
        bodyHtml: body,
    });
    return new Response(response.body, { status: 403, headers: response.headers });
}
