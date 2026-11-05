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
    const exactSubmitSelector = 'button[type="submit"]:has-text("أكّد طلبك الآن")';
    const selectors = [
        exactSubmitSelector,
        'button[type="submit"]:has-text("الدفع عند الاستلام")'
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

    const roleLocator = page.getByRole('button', { name: /أكّد طلبك الآن/ }).first();
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
            const frameRole = frame.getByRole('button', { name: /أكّد طلبك الآن/ }).first();
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
        const targetUrl = config.url3;
        if (!targetUrl) {
            throw new Error('config.url3 is required for the furniture form.');
        }
        console.log(`Navigating to ${targetUrl}...`);
        // Faster loading strategy for slow proxies
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        console.log('Waiting for order form to appear...');
        await page.waitForSelector('button:has-text("7مقاعد"), button:has(img[alt="بني"])', { timeout: 30000 });
        await humanPause(300, 700);

        // 1. Select the first seating offer.
        const offers = page.locator('button').filter({ hasText: '7مقاعد (3+2+1+1)' });
        const offersCount = await offers.count();
        if (offersCount === 0) {
            throw new Error('No product offers found.');
        }
        await offers.first().click({ force: true });
        console.log('Selected first seating offer: 7مقاعد (3+2+1+1)');
        await humanPause(200, 500);

        // 2. Select the first color option.
        const options = page.locator('button').filter({ has: page.locator('img[alt="بني"]') });
        const optionsCount = await options.count();
        if (optionsCount > 0) {
            const selectedOption = options.first();
            await selectedOption.click({ force: true });
            console.log('Selected first color option: بني');
            await humanPause(200, 500);
        } else {
            throw new Error('No color options found.');
        }

        // 3. Fill customer information.
        console.log('Filling personal information...');
        const fullNameField = page.locator('input[name="customer_name"]');
        if (!(await fullNameField.count())) {
            throw new Error('Customer name input not found.');
        }
        await humanType(page, fullNameField.first(), person.fullName);

        const phoneField = page.locator('input[name="customer_phone"]');
        if (!(await phoneField.count())) {
            throw new Error('Customer phone input not found.');
        }
        await humanType(page, phoneField.first(), person.phoneNumber);

        // 4. Select Wilaya (the first required select).
        const requiredSelects = page.locator('select[required]');
        const selectCount = await requiredSelects.count();
        if (selectCount < 2) {
            throw new Error('Wilaya and commune selects not found.');
        }

        const wilayaSelector = requiredSelects.nth(0);
        const wilayaOptions = wilayaSelector.locator('option:not([value=""])');
        const wilayaCount = await wilayaOptions.count();
        if (wilayaCount === 0) {
            throw new Error('No wilaya options found.');
        }
        const wilayaIndex = config.wilaya === 'random'
            ? Math.floor(Math.random() * wilayaCount)
            : 0;
        const wilayaValue = await wilayaOptions.nth(wilayaIndex).getAttribute('value');
        await wilayaSelector.selectOption(wilayaValue);
        console.log(`Selected wilaya: ${await wilayaOptions.nth(wilayaIndex).innerText()}`);
        await humanPause(250, 600);

        // 5. Wait for the dependent commune and select its first option.
        console.log('Waiting for commune dropdown...');
        const communeSelector = requiredSelects.nth(1);
        await communeSelector.waitFor({ state: 'attached', timeout: 15000 });
        await page.waitForFunction((select) => (
            !select.disabled && select.options.length > 1
        ), await communeSelector.elementHandle(), { timeout: 15000 });

        const communeOptions = communeSelector.locator('option:not([value=""])');
        const communeCount = await communeOptions.count();
        if (communeCount === 0) {
            throw new Error('No commune options loaded after selecting the wilaya.');
        }
        const communeIndex = config.commune === 'random'
            ? Math.floor(Math.random() * communeCount)
            : 0;
        const communeValue = await communeOptions.nth(communeIndex).getAttribute('value');
        await communeSelector.selectOption(communeValue);
        console.log(`Selected commune: ${await communeOptions.nth(communeIndex).innerText()}`);
        await humanPause(250, 600);

        // 6. Complete Order
        if (config.dryRun) {
            console.log('DRY RUN: Success! Form filled.');
        } else {
            console.log('SUBMITTING ORDER!');
            const redirectPromise = page.waitForURL(
                (url) => /\/store-fly\/orders\/[^/]+\/success(?:[/?#]|$)/i.test(url.pathname),
                { timeout: 60000 }
            );
            const clicked = await clickSubmit(page);
            if (!clicked) {
                throw new Error('Submit button not found or not clickable.');
            }
            console.log('Submit button clicked. Waiting for redirect...');
            await redirectPromise;
            console.log(`SUCCESS: Order confirmation reached at ${page.url()}`);
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
