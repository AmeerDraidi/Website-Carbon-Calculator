const express = require('express');
const puppeteer = require('puppeteer');
const axios = require('axios');
const xml2js = require('xml2js');
const zlib = require('zlib');
const cors = require('cors');
const path = require('path');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- CONSTANTS & CONFIG ---
const MAX_PAGES = 50;
const USER_AGENT = 'Mozilla/5.0 (compatible; CarbonAuditBot/1.0; +http://localhost:3000)';

// --- HELPER FUNCTIONS ---

// Sleep helper for rate limiting
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Parse XML (handles GZIP if needed)
async function parseXml(data) {
    try {
        // Check if gzipped (magic numbers 1f 8b)
        const isGzip = data[0] === 0x1f && data[1] === 0x8b;
        let xmlString = data;
        
        if (isGzip) {
            xmlString = zlib.gunzipSync(data).toString();
        }

        return await xml2js.parseStringPromise(xmlString, { explicitArray: false });
    } catch (e) {
        console.error('XML Parse Error:', e.message);
        return null;
    }
}

// Fetch and parse sitemap
async function fetchSitemap(url) {
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 10000,
            headers: { 'User-Agent': USER_AGENT }
        });
        return await parseXml(response.data);
    } catch (e) {
        return null;
    }
}

// Recursive sitemap discovery
async function discoverUrls(startUrl, collectedUrls = new Set()) {
    // If we already have enough, stop (soft limit for recursion)
    if (collectedUrls.size >= 500) return collectedUrls;

    const parsed = await fetchSitemap(startUrl);
    if (!parsed) return collectedUrls;

    // Handle Sitemap Index (nested sitemaps)
    if (parsed.sitemapindex && parsed.sitemapindex.sitemap) {
        const sitemaps = Array.isArray(parsed.sitemapindex.sitemap) 
            ? parsed.sitemapindex.sitemap 
            : [parsed.sitemapindex.sitemap];
        
        for (const sm of sitemaps) {
            if (collectedUrls.size >= 500) break;
            if (sm.loc) await discoverUrls(sm.loc.trim(), collectedUrls);
        }
    } 
    // Handle URL Set (actual pages)
    else if (parsed.urlset && parsed.urlset.url) {
        const urls = Array.isArray(parsed.urlset.url) 
            ? parsed.urlset.url 
            : [parsed.urlset.url];
        
        for (const u of urls) {
            if (u.loc) {
                const cleanUrl = u.loc.trim();
                // Filter non-HTML assets
                if (!cleanUrl.match(/\.(pdf|jpg|jpeg|png|gif|webp|svg|mp4|zip|xml|gz)$/i)) {
                    collectedUrls.add(cleanUrl);
                }
            }
        }
    }

    return collectedUrls;
}

// Sampling logic
function sampleUrls(allUrls, homepage) {
    const urlArray = Array.from(allUrls);
    
    // Ensure homepage is included if not present
    if (!urlArray.includes(homepage)) {
        urlArray.unshift(homepage);
    }

    if (urlArray.length <= MAX_PAGES) {
        return urlArray;
    }

    // Sampling strategy: Homepage + First 5 + Last 5 + Random
    const result = new Set();
    result.add(homepage);

    // Remove homepage from pool to avoid dupes
    const pool = urlArray.filter(u => u !== homepage);

    // First 5
    for (let i = 0; i < 5 && i < pool.length; i++) result.add(pool[i]);
    
    // Last 5
    for (let i = pool.length - 1; i >= pool.length - 5 && i >= 0; i--) result.add(pool[i]);

    // Fill rest with random
    while (result.size < MAX_PAGES && result.size < urlArray.length) {
        const randomUrl = pool[Math.floor(Math.random() * pool.length)];
        result.add(randomUrl);
    }

    return Array.from(result);
}

const { co2, hosting } = require('@tgwf/co2');

// Initialize CO2.js with the Sustainable Web Design model
const swd = new co2({ model: 'swd' });

function calculateCarbon(bytes, isGreen) {
    // Calculate emissions using the official SWD model via CO2.js
    // perVisit() returns the estimated CO2e in grams for a single visit
    // It handles the new/returning visitor logic and data cache ratio internally
    const emissions = swd.perVisit(bytes, isGreen);

    // Calculate Rating (based on Website Carbon's grading scale)
    // Approximate scale based on 2024 data
    // A+: < 0.095
    // A: < 0.186
    // B: < 0.341
    // C: < 0.493
    // D: < 0.656
    // E: < 0.846
    // F: > 0.846
    let rating = 'F';
    if (emissions < 0.095) rating = 'A+';
    else if (emissions < 0.186) rating = 'A';
    else if (emissions < 0.341) rating = 'B';
    else if (emissions < 0.493) rating = 'C';
    else if (emissions < 0.656) rating = 'D';
    else if (emissions < 0.846) rating = 'E';

    // Cleaner Than % (Based on the rating system percentiles)
    // A+ Top 5% (Cleaner than 95%)
    // A  Top 20% (Cleaner than 80%)
    // B  Top 40% (Cleaner than 60%)
    // C  Top 50% (Cleaner than 50%)
    // D  Top 60% (Cleaner than 40%)
    // E  Top 80% (Cleaner than 20%)
    // F  Bottom 20% (Cleaner than <20%)
    let cleanerThan = 0;
    if (rating === 'A+') cleanerThan = 0.95;
    else if (rating === 'A') cleanerThan = 0.80;
    else if (rating === 'B') cleanerThan = 0.60;
    else if (rating === 'C') cleanerThan = 0.50;
    else if (rating === 'D') cleanerThan = 0.40;
    else if (rating === 'E') cleanerThan = 0.20;
    else cleanerThan = 0.10; // Average for F

    // Calculate energy (kWh)
    // CO2.js doesn't expose raw energy in perVisit, but we can estimate it
    // SWD v4 global carbon intensity is approx 494 g/kWh
    // So Energy (kWh) = Emissions (g) / 494
    const energy = emissions / 494;

    return {
        gco2e: emissions,
        rating: rating,
        cleanerThan: cleanerThan,
        statistics: {
            adjustedBytes: bytes * 0.75, // Approx adjustment for display
            energy: energy,
            co2: {
                grid: { grams: emissions },
                renewable: { grams: emissions * (isGreen ? 0.8 : 1) } // Placeholder
            }
        }
    };
}

// Puppeteer Measurement (CDP Method)
async function measurePageBytes(browser, url) {
    let page = null;
    let client = null;
    try {
        page = await browser.newPage();
        
        // Set Viewport and User Agent to mimic a real desktop user
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // Enable Request Interception to block media
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resourceType = req.resourceType();
            const url = req.url().toLowerCase();
            
            // Block media (video/audio) to match Website Carbon's likely behavior
            if (resourceType === 'media' || 
                url.endsWith('.mp4') || 
                url.endsWith('.webm') || 
                url.endsWith('.ogg') || 
                url.endsWith('.mp3') || 
                url.endsWith('.wav')) {
                req.abort();
            } else {
                req.continue();
            }
        });

        client = await page.createCDPSession();

        // Enable Network tracking via Chrome DevTools Protocol
        await client.send('Network.enable');

        let totalEncodedBytes = 0;
        const resources = new Map();

        // Track responses to get content-length as fallback
        client.on('Network.responseReceived', (params) => {
            const { requestId, response } = params;
            const headers = response.headers || {};
            // content-length is case-insensitive
            const contentLength = headers['content-length'] || headers['Content-Length'];
            
            resources.set(requestId, {
                url: response.url,
                encodedDataLength: 0,
                contentLength: contentLength ? parseInt(contentLength, 10) : 0
            });
        });

        // encodedDataLength = actual compressed wire-transfer bytes
        client.on('Network.loadingFinished', (params) => {
            const { requestId, encodedDataLength } = params;
            if (resources.has(requestId)) {
                const res = resources.get(requestId);
                res.encodedDataLength = encodedDataLength;
                resources.set(requestId, res);
            }
        });

        const response = await page.goto(url, {
            waitUntil: 'networkidle0', // Wait until network is idle (no connections for 500ms)
            timeout: 60000 // Increased timeout for heavier pages
        });

        // Detect blocked pages via HTTP status
        const status = response ? response.status() : 0;
        if (status === 401 || status === 403) {
            return { bytes: 0, status: 'blocked' };
        }

        // Auto-scroll to trigger lazy loading
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 100;
                const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;

                    if (totalHeight >= scrollHeight - window.innerHeight) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 100);
            });
        });

        // Extra wait for any late lazy-loading after scroll
        await sleep(3000);

        // Sum up bytes
        const resourceList = [];
        for (const [requestId, res] of resources) {
            let size = 0;
            if (res.encodedDataLength > 0) {
                size = res.encodedDataLength;
            } else if (res.contentLength > 0) {
                size = res.contentLength;
            }
            totalEncodedBytes += size;
            resourceList.push({ url: res.url, size });
        }
        
        // Sort and log top resources
        resourceList.sort((a, b) => b.size - a.size);
        const topResources = resourceList.slice(0, 10).map(r => ({
            url: r.url,
            kb: (r.size / 1024).toFixed(2)
        }));

        console.log(`\n--- Scan Details for ${url} ---`);
        console.log(`Total Bytes: ${totalEncodedBytes}`);
        console.log('Top 10 Largest Resources:');
        topResources.forEach(r => {
            console.log(`- ${r.kb} KB: ${r.url}`);
        });
        console.log('--------------------------------\n');
        
        console.log(`Scanned ${url}: ${resources.size} resources, ${totalEncodedBytes} bytes`);

        return { bytes: totalEncodedBytes, status: 'ok', topResources };

    } catch (err) {
        if (err.message && (err.message.includes('403') || err.message.includes('401'))) {
            return { bytes: 0, status: 'blocked' };
        }
        return { bytes: 0, status: 'error', error: err.message };
    } finally {
        if (client) await client.detach().catch(() => {});
        if (page) await page.close().catch(() => {});
    }
}

// Calculate Overall Grade (Mode of per-page ratings)
function calculateOverallGrade(ratings) {
    if (!ratings || ratings.length === 0) return 'F';

    const counts = {};
    let maxCount = 0;

    // Count frequencies
    ratings.forEach(r => {
        counts[r] = (counts[r] || 0) + 1;
        if (counts[r] > maxCount) maxCount = counts[r];
    });

    // Find all grades with the max frequency
    const modes = Object.keys(counts).filter(r => counts[r] === maxCount);

    // If tie, pick the worst grade (A+ is best, F is worst)
    // Order: A+, A, B, C, D, E, F
    const gradeOrder = ['A+', 'A', 'B', 'C', 'D', 'E', 'F'];
    
    // Sort modes by index in gradeOrder (descending index = worse grade)
    modes.sort((a, b) => gradeOrder.indexOf(b) - gradeOrder.indexOf(a));

    return modes[0];
}

// --- API ROUTES ---

app.get('/api/scan', async (req, res) => {
    const targetUrl = req.query.url;
    const mode = req.query.mode || 'full'; // 'full' or 'single'
    
    // SSE Setup
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Validate URL
    let parsedUrl;
    try {
        parsedUrl = new URL(targetUrl);
    } catch (e) {
        send('error', { message: 'Invalid URL provided.' });
        res.end();
        return;
    }

    const baseUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}`;
    let browser = null;

    try {
        let finalUrls = [];
        let totalFound = 0;

        if (mode === 'single') {
            finalUrls = [targetUrl];
            totalFound = 1;
        } else {
            // STEP 1: Sitemap Discovery
            send('progress', { step: 'sitemap', message: 'Discovering pages via sitemap...' });
            
            let allUrls = new Set();
            
            // Priority 1: sitemap_index.xml
            allUrls = await discoverUrls(`${baseUrl}/sitemap_index.xml`);
            
            // Priority 2: sitemap.xml
            if (allUrls.size === 0) {
                allUrls = await discoverUrls(`${baseUrl}/sitemap.xml`);
            }

            // Priority 3: robots.txt
            if (allUrls.size === 0) {
                try {
                    const robots = await axios.get(`${baseUrl}/robots.txt`, { timeout: 5000 });
                    const lines = robots.data.toString().split('\n');
                    const sitemapLine = lines.find(l => l.toLowerCase().startsWith('sitemap:'));
                    if (sitemapLine) {
                        const sitemapUrl = sitemapLine.split(/:\s*/)[1].trim();
                        allUrls = await discoverUrls(sitemapUrl);
                    }
                } catch (e) { /* ignore */ }
            }

            // Fallback: Homepage only
            if (allUrls.size === 0) {
                allUrls.add(baseUrl); // normalize to base
                // Also try the exact input URL if different
                if (targetUrl !== baseUrl && targetUrl !== baseUrl + '/') {
                    allUrls.add(targetUrl);
                }
                send('progress', { step: 'sitemap', message: 'No sitemap found — scanning homepage only.' });
            }

            totalFound = allUrls.size;
            finalUrls = sampleUrls(allUrls, targetUrl);
        }
        
        // STEP 2: Green Check
        send('progress', { step: 'greencheck', message: 'Checking green hosting status...' });
        let isGreen = false;
        try {
            const domain = parsedUrl.hostname;
            // Use the official @tgwf/co2 hosting check
            // hosting.check() returns true/false or an object depending on version
            // In v0.17+, it returns a boolean or object. Let's handle both.
            // Actually, hosting.check(domain) returns a promise that resolves to true/false or object.
            // The docs say: hosting.check("google.com").then((result) => { console.log(result); });
            // The result is usually a boolean or an object with 'green' property.
            
            const checkResult = await hosting.check(domain);
            
            // Handle different return types
            if (typeof checkResult === 'boolean') {
                isGreen = checkResult;
            } else if (checkResult && typeof checkResult === 'object') {
                // It might return an array or object
                // If it's the API response directly: { url: ..., green: true, ... }
                // Or if it's the library wrapper: it might return boolean.
                // Let's assume if it has a 'green' property, use that.
                if ('green' in checkResult) {
                    isGreen = checkResult.green === true;
                } else {
                    // Fallback: check if the result itself is truthy (some versions return array of green domains)
                    isGreen = !!checkResult;
                }
            }
            
            console.log(`Green check for ${domain}: ${isGreen}`);

        } catch (e) {
            console.error('Green check failed, defaulting to false', e.message);
        }

        // STEP 3: Launch Browser
        send('progress', { step: 'browser', message: 'Launching headless browser...' });
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--ignore-certificate-errors',
                '--disable-features=IsolateOrigins,site-per-process' // Capture OOPIFs in main session
            ]
        });

        // STEP 4: Scan Loop
        const results = [];
        
        for (let i = 0; i < finalUrls.length; i++) {
            const url = finalUrls[i];
            
            // Measure
            const measureResult = await measurePageBytes(browser, url);
            
            let pageData = {
                url,
                bytes: measureResult.bytes,
                kb: (measureResult.bytes / 1024).toFixed(2),
                status: measureResult.status,
                green: isGreen,
                topResources: measureResult.topResources || []
            };

            if (measureResult.status === 'ok') {
                try {
                    // Local SWDM v4 Calculation
                    const data = calculateCarbon(measureResult.bytes, isGreen);
                    
                    // CRITICAL: Use data.gco2e as the primary metric
                    pageData.gco2e = data.gco2e;
                    pageData.rating = data.rating;
                    pageData.cleanerThan = data.cleanerThan;
                    pageData.adjustedBytes = data.statistics.adjustedBytes;
                    pageData.energy = data.statistics.energy;
                    
                    // Store reference values
                    pageData.gridGrams = data.statistics.co2.grid.grams;
                    pageData.renewableGrams = data.statistics.co2.renewable.grams;

                } catch (e) {
                    pageData.status = 'api_error';
                    pageData.error = 'Carbon Calculation failed';
                }
            }

            results.push(pageData);

            // Send Page Update
            send('page', {
                ...pageData,
                index: i + 1,
                total: finalUrls.length
            });

            // Rate limit delay between pages
            await sleep(500);
        }

        // STEP 5: Aggregation
        const validPages = results.filter(p => p.status === 'ok');
        
        let stats = {};
        if (validPages.length > 0) {
            const totalCo2 = validPages.reduce((sum, p) => sum + p.gco2e, 0);
            const avgCo2 = totalCo2 / validPages.length;
            
            const totalBytes = validPages.reduce((sum, p) => sum + p.bytes, 0);
            const avgBytes = totalBytes / validPages.length;

            const totalAdjustedBytes = validPages.reduce((sum, p) => sum + p.adjustedBytes, 0);
            const avgAdjustedBytes = totalAdjustedBytes / validPages.length;
            
            const totalCleaner = validPages.reduce((sum, p) => sum + p.cleanerThan, 0);
            const avgCleaner = totalCleaner / validPages.length;

            const totalEnergy = validPages.reduce((sum, p) => sum + p.energy, 0);
            const avgEnergy = totalEnergy / validPages.length;

            // Median
            const sortedCo2 = [...validPages].sort((a, b) => a.gco2e - b.gco2e);
            const medianCo2 = sortedCo2[Math.floor(sortedCo2.length / 2)].gco2e;

            // Rating Calculation (Mode of per-page ratings)
            const allRatings = validPages.map(p => p.rating);
            const overallRating = calculateOverallGrade(allRatings);

            // Annual Impact (10k views/mo)
            const annualKg = (avgCo2 * 10000 * 12) / 1000;
            const treesNeeded = Math.ceil(annualKg / 21);
            const kmDriven = Math.round(annualKg * 5.5);
            
            // Annual Energy (kWh)
            const annualEnergyKwh = avgEnergy * 10000 * 12;

            // Max Page Size (for recs)
            const maxPageKb = Math.max(...validPages.map(p => parseFloat(p.kb)));
            
            // Pct Bad Rating (for recs)
            const badPages = validPages.filter(p => ['D','E','F'].includes(p.rating)).length;
            const pctBadRating = badPages / validPages.length;

            stats = {
                avgCo2,
                medianCo2,
                avgBytes,
                avgKb: avgBytes / 1024,
                avgAdjustedKb: avgAdjustedBytes / 1024,
                avgCleanerThan: avgCleaner,
                overallRating,
                totalScanned: validPages.length,
                totalFound: totalFound,
                sampled: finalUrls.length,
                isGreenHost: isGreen,
                annualKg,
                treesNeeded,
                kmDriven,
                kwhPerYear: annualEnergyKwh,
                maxPageKb,
                pctBadRating
            };
        } else {
            stats = { error: "No pages successfully scanned" };
        }

        send('complete', { results, stats });

    } catch (e) {
        console.error('Scan Error:', e);
        send('error', { message: e.message || 'Internal Server Error' });
    } finally {
        if (browser) await browser.close();
        res.end();
    }
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
});
