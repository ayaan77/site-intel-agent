import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { Browser, BrowserContext, Page } from 'playwright-core';
import dotenv from 'dotenv';
dotenv.config();

// Add stealth plugin to playwright-extra
chromium.use(stealth());

export interface ActionPayload {
    action: 'goto' | 'extract' | 'click' | 'type' | 'scrapeMetaAds';
    url: string;
    selector?: string;
    text?: string;
}

let browser: Browser | null = null;
let context: BrowserContext | null = null;

async function initBrowser() {
    if (!browser || !context) {
        const headless = process.env.HEADLESS_MODE !== 'false';
        browser = await chromium.launch({
            headless,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
            ],
        });
        context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 },
        });
    }
    return context;
}

export async function executeAction(payload: ActionPayload): Promise<any> {
    const ctx = await initBrowser();
    const p = await ctx.newPage();

    try {
        switch (payload.action) {
            case 'goto':
                await p.goto(payload.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                const title = await p.title();
                return { success: true, action: 'goto', title };

            case 'extract': {
                // Navigate if we aren't already there
                const currentUrl = p.url();
                if (currentUrl !== payload.url && currentUrl !== payload.url.replace(/\/$/, '')) {
                    // Use 'domcontentloaded' — NOT 'networkidle'. SPAs (React/Next.js/Shopify) never
                    // truly go networkidle because analytics, chat widgets, and hydration keep firing.
                    // 'networkidle' causes the browser to hang for the full 20s timeout every time.
                    await p.goto(payload.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
                }

                // Wait for the main content area to be present, with a max cap of 3 seconds
                await p.waitForTimeout(1500);

                // Extract a rich structured payload from the live DOM
                const extracted = await p.evaluate(() => {
                    const getAttr = (el: Element | null, attr: string): string =>
                        el?.getAttribute(attr) || '';

                    // ── HEAD metadata ──────────────────────────────────────
                    const metaTags: Record<string, string> = {};
                    document.querySelectorAll('head meta').forEach(m => {
                        const name = m.getAttribute('name') || m.getAttribute('property') || m.getAttribute('http-equiv');
                        const content = m.getAttribute('content');
                        if (name && content) metaTags[name] = content;
                    });

                    // ── Title ──────────────────────────────────────────────
                    const pageTitle = document.title || '';

                    // ── Canonical ──────────────────────────────────────────
                    const canonicalEl = document.querySelector('link[rel="canonical"]');
                    const canonical = getAttr(canonicalEl, 'href');

                    // ── Sitemap + Robots ───────────────────────────────────
                    const sitemapEl = document.querySelector('link[rel="sitemap"]');
                    const sitemapHref = getAttr(sitemapEl, 'href');

                    // ── JSON-LD structured data ────────────────────────────
                    const jsonLdBlocks: string[] = [];
                    document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
                        jsonLdBlocks.push(s.textContent || '');
                    });

                    // ── Script sources (for pixel/analytics detection) ─────
                    const scriptSrcs: string[] = [];
                    document.querySelectorAll('script[src]').forEach(s => {
                        const src = s.getAttribute('src') || '';
                        if (src) scriptSrcs.push(src);
                    });

                    // ── Headings ───────────────────────────────────────────
                    const h1s = Array.from(document.querySelectorAll('h1')).map(h => h.textContent?.trim() || '');
                    const h2s = Array.from(document.querySelectorAll('h2')).map(h => h.textContent?.trim() || '');
                    const h3s = Array.from(document.querySelectorAll('h3')).map(h => h.textContent?.trim() || '');

                    // ── Images ─────────────────────────────────────────────
                    const allImages = document.querySelectorAll('img');
                    const missingAlt = Array.from(allImages).filter(i => !i.getAttribute('alt') || i.getAttribute('alt') === '').length;

                    // ── Links ──────────────────────────────────────────────
                    const host = window.location.hostname;
                    const allLinks = Array.from(document.querySelectorAll('a[href]'));
                    const internalLinks = allLinks.filter(a => {
                        const href = a.getAttribute('href') || '';
                        return href.startsWith('/') || href.includes(host);
                    }).length;
                    const externalLinks = allLinks.length - internalLinks;

                    // ── Body text (clean) ──────────────────────────────────
                    const bodyClone = document.body.cloneNode(true) as HTMLElement;
                    bodyClone.querySelectorAll('script, style, noscript, svg, iframe').forEach(el => el.remove());
                    const bodyText = (bodyClone.innerText || bodyClone.textContent || '').replace(/\n\s*\n/g, '\n\n').trim();

                    return {
                        pageTitle,
                        canonical,
                        sitemapHref,
                        metaTags,
                        jsonLdBlocks,
                        scriptSrcs,
                        headings: { h1s, h2s, h3s },
                        images: { total: allImages.length, missingAlt },
                        links: { total: allLinks.length, internal: internalLinks, external: externalLinks },
                        bodyText
                    };
                });

                // Build a rich context string for the LLM
                const lines: string[] = [];
                lines.push(`=== URL ===\n${payload.url}`);
                lines.push(`\n=== PAGE TITLE ===\n${extracted.pageTitle}`);
                lines.push(`\n=== META TAGS ===`);
                for (const [k, v] of Object.entries(extracted.metaTags)) {
                    lines.push(`${k}: ${v}`);
                }
                if (extracted.canonical) {
                    lines.push(`\n=== CANONICAL ===\n${extracted.canonical}`);
                }
                if (extracted.sitemapHref) {
                    lines.push(`\n=== SITEMAP LINK ===\n${extracted.sitemapHref}`);
                }
                lines.push(`\n=== JSON-LD STRUCTURED DATA ===`);
                if (extracted.jsonLdBlocks.length > 0) {
                    extracted.jsonLdBlocks.forEach((b, i) => lines.push(`Block ${i + 1}:\n${b.substring(0, 800)}`));
                } else {
                    lines.push('None detected');
                }
                lines.push(`\n=== SCRIPT SOURCES (for pixel/analytics detection) ===`);
                extracted.scriptSrcs.slice(0, 40).forEach(src => lines.push(src));
                lines.push(`\n=== HEADINGS ===`);
                lines.push(`H1 (${extracted.headings.h1s.length}): ${extracted.headings.h1s.join(' | ')}`);
                lines.push(`H2 (${extracted.headings.h2s.length}): ${extracted.headings.h2s.slice(0, 8).join(' | ')}`);
                lines.push(`H3 (${extracted.headings.h3s.length}): ${extracted.headings.h3s.slice(0, 6).join(' | ')}`);
                lines.push(`\n=== IMAGES ===\nTotal: ${extracted.images.total}, Missing alt: ${extracted.images.missingAlt}`);
                lines.push(`\n=== LINKS ===\nTotal: ${extracted.links.total}, Internal: ${extracted.links.internal}, External: ${extracted.links.external}`);
                lines.push(`\n=== BODY TEXT ===\n${extracted.bodyText.substring(0, 15000)}`);

                const richContent = lines.join('\n');

                return {
                    success: true,
                    action: 'extract',
                    url: payload.url,
                    content: richContent
                };
            }

            case 'scrapeMetaAds': {
                // Meta Ads Library requires a robust load time because it is a heavy React SPA.
                // It makes search queries to the backend after the DOM is loaded.

                await p.goto(payload.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

                // Wait for the main results container or the "No ads" state.
                // We'll give it up to 8 seconds to settle the API calls.
                await p.waitForTimeout(8000);

                // Try to scroll down to trigger lazy loading if there are many ads
                await p.mouse.wheel(0, 2000);
                await p.waitForTimeout(2000);

                const extractedMetaText = await p.evaluate(() => {
                    // Remove all the useless UI chrome to prevent polluting the LLM token window
                    document.querySelectorAll('header, nav, footer, style, script, svg').forEach(el => el.remove());

                    // We specifically want the main results area. If it exists, extract just that.
                    const resultsDiv = document.querySelector('div[role="main"]') || document.body;

                    // Extract clean text
                    let text = (resultsDiv as HTMLElement).innerText || resultsDiv.textContent || '';
                    text = text.replace(/\n\s*\n/g, '\n\n').trim();

                    return text;
                });

                return {
                    success: true,
                    action: 'scrapeMetaAds',
                    url: payload.url,
                    content: extractedMetaText
                };
            }

            case 'click':
                if (!payload.selector) throw new Error('Selector needed for click action');
                if (p.url() !== payload.url) {
                    await p.goto(payload.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                }
                await p.click(payload.selector, { timeout: 10000 });
                return { success: true, action: 'click', selector: payload.selector };

            case 'type':
                if (!payload.selector || !payload.text) throw new Error('Selector and text needed for type action');
                if (p.url() !== payload.url) {
                    await p.goto(payload.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                }
                await p.fill(payload.selector, payload.text, { timeout: 10000 });
                return { success: true, action: 'type', selector: payload.selector };

            default:
                throw new Error(`Unknown action: ${payload.action}`);
        }
    } catch (e: any) {
        // In case of a major crash, we might need to reset the browser
        console.error(`Browser Action failed:`, e);
        // Clean up browser instance on failure allowing a fresh start next time
        if (browser) {
            await browser.close().catch(() => { });
            browser = null;
            context = null;
        }
        throw e;
    } finally {
        await p.close().catch(() => { });
    }
}

// Ensure cleanup on exit
process.on('SIGINT', async () => {
    if (browser) await browser.close();
    process.exit();
});
process.on('SIGTERM', async () => {
    if (browser) await browser.close();
    process.exit();
});
