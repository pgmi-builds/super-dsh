import { buildZoomGuardSection } from './mobile/zoom-guard.js';
/**
 * Build the boot script text. Pure: same constants in, same script out — the
 * unit tests pin the shape (mobile global present, zoom-guard section present,
 * wrapped in a non-throwing IIFE).
 *
 * @returns the script text.
 */
export function buildMobileBootScript() {
    const parts = ['(function(){try{'];
    // Ship default ON: a bare page carries the mobile global (the client's
    // `resolveMobileConfig` merges the threshold defaults over `enabled: true`).
    parts.push(`window.__OMP_WEB_MOBILE__=${JSON.stringify({ enabled: true })};`);
    // The zoom guard rides the mobile leg (default 'meta' mode): emitted always.
    parts.push(buildZoomGuardSection());
    parts.push('}catch(e){}})();');
    return parts.join('');
}
/**
 * Mount the boot-script injection: one `webserver/index-inject` listener
 * pushing the rendered row. Conditional on the webServer service, so the
 * plugin loads (with the feature dormant) in compositions without one.
 * Fail-open: a push failure is logged, never thrown.
 *
 * @param ctx - host plugin context.
 */
export function installMobileBootScript(ctx) {
    ctx.inject(['webServer'], () => {
        ctx.on('webserver/index-inject', (table) => {
            try {
                table.push({ kind: 'script', placement: 'head', text: buildMobileBootScript() });
            }
            catch (error) {
                ctx.logger.warn(`omp-web: mobile boot script injection failed: ${String(error)}`);
            }
        });
    });
}
