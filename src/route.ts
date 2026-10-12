const idPatterns = [
    /^\d+$/,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    /^[0-9a-f]{16,}$/i,
    /^[0-9A-HJKMNP-TV-Z]{26}$/,
];

export function normalizeSegments(path: string): string {
    const segments = path
        .split('/')
        .filter((segment) => segment !== '')
        .map((segment) => (idPatterns.some((pattern) => pattern.test(segment)) ? '{id}' : segment));

    return segments.length === 0 ? '' : `/${segments.join('/')}`;
}

export function joinRoute(baseUrl: string, routePath: string): string {
    const base = normalizeSegments(baseUrl);
    const tail = routePath === '/' ? '' : routePath.startsWith('/') ? routePath : `/${routePath}`;
    const joined = `${base}${tail}`;

    return joined === '' ? '/' : joined;
}

export function stripQuery(url: string): string {
    const index = url.search(/[?#]/);

    return index === -1 ? url : url.slice(0, index);
}
