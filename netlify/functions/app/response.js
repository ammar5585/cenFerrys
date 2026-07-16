// Small Response-building helpers so route handlers don't repeat
// header/cookie plumbing. `cookies` is an array of Set-Cookie header
// values (session reissue + flash message can both be present at once).

export function htmlResponse(bodyString, { status = 200, cookies = [] } = {}) {
    const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8' });
    for (const c of cookies) headers.append('Set-Cookie', c);
    return new Response(bodyString, { status, headers });
}

export function redirectTo(location, { cookies = [] } = {}) {
    const headers = new Headers({ Location: location });
    for (const c of cookies) headers.append('Set-Cookie', c);
    return new Response(null, { status: 302, headers });
}

export function jsonResponse(obj, { status = 200, cookies = [] } = {}) {
    const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
    for (const c of cookies) headers.append('Set-Cookie', c);
    return new Response(JSON.stringify(obj), { status, headers });
}

export function forbidden(message = 'Forbidden') {
    return new Response(
        `<h2>403 Forbidden</h2><p>${message}</p><a href="/dashboard">Return to dashboard</a>`,
        { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
}

export function notFound(message = 'Not found') {
    return new Response(`<h2>404 Not Found</h2><p>${message}</p>`, {
        status: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}

export function csvResponse(csvString, filename) {
    return new Response(csvString, {
        status: 200,
        headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${filename}"`,
        },
    });
}

/** `buffer` is the Buffer/Uint8Array from an exceljs Workbook's writeBuffer(). */
export function xlsxResponse(buffer, filename) {
    return new Response(buffer, {
        status: 200,
        headers: {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="${filename}"`,
        },
    });
}
