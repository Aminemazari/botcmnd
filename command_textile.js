const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');

function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDailySchedule(requestCount, durationMs) {
    if (requestCount <= 1) return [];

    const weights = Array.from({ length: requestCount - 1 }, () => 0.5 + Math.random());
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    return weights.map((weight) => Math.round((weight / totalWeight) * durationMs));
}

function pickProxy(proxies, previousProxy = null) {
    if (proxies.length === 0) return null;
    const candidates = previousProxy && proxies.length > 1
        ? proxies.filter((proxy) => proxy !== previousProxy)
        : proxies;
    return candidates[Math.floor(Math.random() * candidates.length)];
}

async function humanPause(min = 150, max = 400) {
    await sleep(randomBetween(min, max));
}

async function humanType(page, target, value) {
    const locator = typeof target === 'string' ? page.locator(target) : target;
    await locator.click({ timeout: 15000, force: true });
    await locator.fill('');
    await locator.type(value, { delay: randomBetween(40, 120) });
    await humanPause(200, 500);
}

async function attemptClick(locator) {
    try {
        await locator.waitFor({ state: 'visible', timeout: 15000 });
    } catch {
        return false;
    }
    try {
        await locator.scrollIntoViewIfNeeded();
    } catch {}
    await humanPause(200, 500);
    try {
        await locator.click({ timeout: 15000 });
        return true;
    } catch {}
    try {
        await locator.click({ timeout: 15000, force: true });
        return true;
    } catch {}
    try {
        await locator.evaluate((element) => element.click());
        return true;
    } catch {}
    return false;
}

async function clickSubmit(page) {
    const exactSubmitSelector = 'button[type="button"].btn-primary';
    const selectors = [
        exactSubmitSelector,
        'button:has-text("أطلب الآن")',
        'button:has-text("اطلب الآن")'
    ];

    const exactSubmit = page.locator(exactSubmitSelector).first();
    if (await exactSubmit.count()) {
        console.log('Clicking exact order submit button...');
        if (await attemptClick(exactSubmit)) return true;
    }

    for (const sel of selectors) {
        const locator = page.locator(sel).first();
        if (await locator.count()) {
            if (await attemptClick(locator)) return true;
        }
    }

    const roleLocator = page.getByRole('button', { name: /أ?طلب الآن/i }).first();
    if (await roleLocator.count()) {
        if (await attemptClick(roleLocator)) return true;
    }

    for (const frame of page.frames()) {
        for (const sel of selectors) {
            const locator = frame.locator(sel).first();
            if (await locator.count()) {
                if (await attemptClick(locator)) return true;
            }
        }

        if (typeof frame.getByRole === 'function') {
            const frameRole = frame.getByRole('button', { name: /أ?طلب الآن/i }).first();
            if (await frameRole.count()) {
                if (await attemptClick(frameRole)) return true;
            }
        }
    }

    return false;
}

async function fetchProxies(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                const list = data.split('\n').filter(line => line.trim() !== '');
                resolve(list);
            });
        }).on('error', (err) => {
            reject(err);
        });
    });
}

async function loadProxies(config) {
    const sources = [];
    if (Array.isArray(config.proxySources)) {
        sources.push(...config.proxySources.filter(Boolean));
    }
    if (typeof config.proxySource === 'string' && config.proxySource.trim()) {
        if (!sources.includes(config.proxySource)) sources.push(config.proxySource);
    }

    const proxies = [];
    for (const src of sources) {
        try {
            if (/^https?:\/\//i.test(src)) {
                const list = await fetchProxies(src);
                proxies.push(...list);
            } else {
                const filePath = path.isAbsolute(src) ? src : path.join(__dirname, src);
                if (fs.existsSync(filePath)) {
                    const list = fs.readFileSync(filePath, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
                    proxies.push(...list);
                }
            }
        } catch (err) {
            console.warn(`Failed to load proxies from ${src}: ${err.message}`);
        }
    }

    return Array.from(new Set(proxies));
}

function buildProxyOptions(proxyString) {
    if (!proxyString || typeof proxyString !== 'string') return null;
    const raw = proxyString.trim();
    if (!raw) return null;

    let serverPart = raw;
    let username;
    let password;

    if (raw.includes('@')) {
        const atIndex = raw.lastIndexOf('@');
        const left = raw.slice(0, atIndex);
        const right = raw.slice(atIndex + 1);

        const leftLooksLikeServer = /^[^@]+:\d+$/.test(left);
        if (leftLooksLikeServer) {
            serverPart = left;
            const [user, ...passParts] = right.split(':');
            username = user;
            password = passParts.join(':');
        } else {
            const [user, ...passParts] = left.split(':');
            username = user;
            password = passParts.join(':');
            serverPart = right;
        }
    } else {
        const parts = raw.split(':');
        if (parts.length === 4) {
            serverPart = `${parts[0]}:${parts[1]}`;
            username = parts[2];
            password = parts[3];
        } else if (parts.length === 2) {
            serverPart = raw;
        }
    }

    if (!/^https?:\/\//i.test(serverPart)) {
        serverPart = `http://${serverPart}`;
    }

    const proxy = { server: serverPart };
    if (username) {
        proxy.username = username;
        proxy.password = password || '';
    }
    return proxy;
}

async function placeOrder(browser, config, person, proxy) {
    console.log(`\n--- Order for ${person.fullName} (${person.phoneNumber}) ---`);
    if (proxy) console.log(`Using Proxy: ${proxy}`);

    const proxyOptions = proxy ? buildProxyOptions(proxy) : null;
    const contextOptions = proxyOptions ? { proxy: proxyOptions } : {};
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    try {
        const targetUrl = config.url2 || config.url;
        if (!targetUrl) {
            throw new Error('config.url2 is required for the textile form.');
        }
        console.log(`Navigating to ${targetUrl}...`);
        // Faster loading strategy for slow proxies
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        console.log('Waiting for order form to appear...');
        await page.waitForSelector('form input[name="fullName"], form input[name="phone"]', { timeout: 30000 });
        await humanPause(300, 700);

        // 1. Select the first product offer.
        const offers = page.locator('input[type="radio"][name="6ada054fd579e8b40214f56c"]');
        const offersCount = await offers.count();
        if (offersCount === 0) {
            throw new Error('No product offers found.');
        }
        await offers.first().check({ force: true });
        console.log(`Selected first product offer: ${await offers.first().getAttribute('id')}`);
        await humanPause(200, 500);

        // 2. Select the first textile/color option.
        const options = page.locator(
            'input[type="checkbox"].checkbox:not(.modal-toggle):not(#multi-product-offers-required-selections-modal)'
        );
        const optionsCount = await options.count();
        if (optionsCount > 0) {
            const selectedOption = options.first();
            await selectedOption.check({ force: true });
            console.log(`Selected first textile option: ${await selectedOption.getAttribute('id')}`);
            await humanPause(200, 500);
        } else {
            throw new Error('No textile options found.');
        }

        // 3. Fill Personal Information
        console.log('Filling personal information...');
        await humanType(page, 'form input[name="fullName"]', person.fullName);
        await humanType(page, 'form input[name="phone"]', person.phoneNumber);

        // 4. Select Wilaya (State)
        const wilayaSelector = 'form select[name="wilaya"]';
        const wilayaOptions = page.locator(`${wilayaSelector} option:not([value=""])`);
        const wilayaCount = await wilayaOptions.count();
        if (wilayaCount === 0) throw new Error('No wilaya options found.');
        const wilayaIndex = config.wilaya === 'random'
            ? Math.floor(Math.random() * wilayaCount)
            : 0;
        const wilayaValue = await wilayaOptions.nth(wilayaIndex).getAttribute('value');
        await page.selectOption(wilayaSelector, wilayaValue);
        console.log(`Selected wilaya: ${await wilayaOptions.nth(wilayaIndex).innerText()}`);
        await humanPause(250, 600);

        // 5. Wait for the dependent commune select and choose the first option.
        console.log('Waiting for commune dropdown...');
        const communeSelector = 'form select[name="address"]';
        await page.waitForFunction(sel => {
            const select = document.querySelector(sel);
            return select && !select.disabled && select.options.length > 1;
        }, communeSelector, { timeout: 15000 });
        
        const communeOptions = page.locator(`${communeSelector} option:not([value=""])`);
        const communeCount = await communeOptions.count();
        if (communeCount === 0) {
            throw new Error('No commune options loaded after selecting the wilaya.');
        }
        const communeIndex = config.commune === 'random'
            ? Math.floor(Math.random() * communeCount)
            : 0;
        const communeValue = await communeOptions.nth(communeIndex).getAttribute('value');
        await page.selectOption(communeSelector, communeValue);
        console.log(`Selected commune: ${await communeOptions.nth(communeIndex).innerText()}`);
        await humanPause(250, 600);

        // The notes field is intentionally left untouched.
        await page.locator('form input[name="deliveryPlace"][value="at_home"]').check();
        await humanPause(200, 500);

        // 7. Complete Order
        if (config.dryRun) {
            console.log('DRY RUN: Success! Form filled.');
        } else {
            console.log('SUBMITTING ORDER!');
            const beforeUrl = page.url();
            const redirectPromise = page.waitForURL(
                (url) => url.toString() !== beforeUrl,
                { timeout: 60000 }
            );
            const clicked = await clickSubmit(page);
            if (!clicked) {
                throw new Error('Submit button not found or not clickable.');
            }
            console.log('Submit button clicked. Waiting for redirect...');
            await redirectPromise;
            console.log(`SUCCESS: Redirected to ${page.url()}`);
        }
        return true;

    } catch (error) {
        console.error(`FAILED: ${person.fullName} - ${error.message}`);
        return false;
    } finally {
        await context.close();
    }
}

async function runBot() {
    const configPath = path.join(__dirname, 'config.json');
    if (!fs.existsSync(configPath)) {
        console.error('Error: config.json not found.');
        return;
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  
    let people = [];

    // Load Data
    if (config.bulkMode) {
        const dataPath = path.join(__dirname, config.dataPath);
        people = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    } else {
        people = [{ fullName: config.fullName, phoneNumber: config.phoneNumber }];
    }

    // Load Proxies
    let proxies = [];
    if (config.useProxies) {
        console.log('Fetching proxies...');
        proxies = await loadProxies(config);
        console.log(`Loaded ${proxies.length} proxies.`);
    }

    const browser = await chromium.launch({ headless: false });

    const dailyRequestLimit = Math.min(Math.max(Number(config.dailyRequestLimit) || 200, 1), 200);
    const scheduleHours = Math.max(Number(config.scheduleHours) || 24, 1);
    const schedule = createDailySchedule(dailyRequestLimit, scheduleHours * 60 * 60 * 1000);
 
    const maxAttempts = Math.max(Number(config.maxAttempts) || 3, 1);

    for (let requestIndex = 0; requestIndex < dailyRequestLimit; requestIndex++) {
        const person = people[requestIndex % people.length];
        console.log(`\n--- Scheduled request ${requestIndex + 1}/${dailyRequestLimit} ---`);
        let success = false;
        let previousProxy = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const proxy = pickProxy(proxies, previousProxy);
            previousProxy = proxy;
            console.log(`Attempt ${attempt}/${maxAttempts} for ${person.fullName}.`);
            success = await placeOrder(browser, config, person, proxy);
            if (success) break;

            if (attempt < maxAttempts) {
                console.log('Attempt failed; switching proxy and retrying immediately.');
            }
        }

        if (!success) {
            console.error(`Giving up on ${person.fullName} after ${maxAttempts} attempts.`);
        }

        if (requestIndex < dailyRequestLimit - 1) {
            const delayMs = schedule[requestIndex];
            console.log(`Waiting ${Math.round(delayMs / 1000)} seconds until the next request...`);
            await sleep(delayMs);
        }
    }

    console.log('\n--- BATCH COMPLETE ---');
    if (config.dryRun) await new Promise(r => setTimeout(r, 30000));
    await browser.close();
}

runBot();
