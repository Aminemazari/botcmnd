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

async function humanType(page, target, value, options = {}) {
    const locator = typeof target === 'string' ? page.locator(target) : target;
    await locator.waitFor({ state: 'visible', timeout: 30000 });
    await locator.click({ timeout: 15000, force: true });
    await locator.fill('');
    const minDelay = options.minDelay || 40;
    const maxDelay = options.maxDelay || 120;
    await locator.type(value, { delay: randomBetween(minDelay, maxDelay) });
    const enteredValue = await locator.inputValue();
    if (enteredValue !== value) {
        throw new Error(`Could not fill input ${typeof target === 'string' ? target : 'field'}.`);
    }
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
    const exactSubmitSelector = 'button.client-inputs__submit';
    const selectors = [
        exactSubmitSelector,
        'button:has-text("اشتر الآن")',
        'button:has-text("أطلب الآن")'
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

    const roleLocator = page.getByRole('button', { name: /اشتر الآن|أطلب الآن/ }).first();
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
            const frameRole = frame.getByRole('button', { name: /اشتر الآن|أطلب الآن/ }).first();
            if (await frameRole.count()) {
                if (await attemptClick(frameRole)) return true;
            }
        }
    }

    return false;
}

async function selectRandomComboboxOption(page, input) {
    await input.click({ timeout: 15000, force: true });
    const options = page.locator('[data-combobox-option="true"]:visible');
    await options.first().waitFor({ state: 'visible', timeout: 15000 });
    const count = await options.count();
    if (count === 0) {
        throw new Error('No visible options found in combobox.');
    }
    const index = Math.floor(Math.random() * count);
    const option = options.nth(index);
    const label = (await option.innerText()).trim();
    await option.click({ timeout: 15000 });
    return { label, index };
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
    let context;

    try {
        if (!browser.isConnected()) {
            throw new Error('Playwright browser is disconnected before creating the page context.');
        }
        context = await browser.newContext(contextOptions);
        const page = await context.newPage();
        const targetUrl = config.url3;
        if (!targetUrl) {
            throw new Error('config.url3 is required for the furniture form.');
        }
        console.log(`Navigating to ${targetUrl}...`);
        // Faster loading strategy for slow proxies
        const response = await page.goto(targetUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });
        const responseStatus = response ? response.status() : 'unknown';
        const pageTitle = await page.title();
        console.log(`Page response: ${responseStatus}; title: ${pageTitle || '(none)'}; url: ${page.url()}`);
        if (response && responseStatus >= 400) {
            throw new Error(
                `The target page returned HTTP ${responseStatus}. It did not load the order form.`
            );
        }
        
        console.log('Waiting for customer form to appear...');
        await page.locator('.client-inputs__fields').waitFor({ state: 'visible', timeout: 30000 });
        await humanPause(300, 700);

        // 1. Fill the exact customer form fields.
        console.log('Filling personal information...');
        const name = page.locator('[data-field="fullName"] input.client-inputs__input').first();
        const phone = page.locator('[data-field="phoneNumber"] input.client-inputs__input').first();
        await humanType(page, name, person.fullName);
        await humanPause(500, 900);
        await humanType(page, phone, person.phoneNumber);

        // 2. Select Wilaya and the dependent city.
        const wilayaSelector = 'select[aria-label="الولاية"]';
        const communeSelector = 'select[aria-label="المدينة"]';
        const wilaya = page.locator(wilayaSelector);
        const commune = page.locator(communeSelector);
        await wilaya.waitFor({ state: 'visible', timeout: 30000 });
        await page.waitForFunction((selector) => {
            const select = document.querySelector(selector);
            return select && Array.from(select.options).some(option => option.value);
        }, wilayaSelector, { timeout: 30000 });
        const wilayaOptions = page.locator(`${wilayaSelector} option:not([disabled])[value]:not([value=""])`);
        const wilayaCount = await wilayaOptions.count();
        if (wilayaCount === 0) {
            throw new Error('No Wilaya options found.');
        }
        const wilayaIndex = config.wilaya === 'random'
            ? Math.floor(Math.random() * wilayaCount)
            : 0;
        const wilayaValue = await wilayaOptions.nth(wilayaIndex).getAttribute('value');
        await page.selectOption(wilayaSelector, wilayaValue);
        console.log(`Selected wilaya: ${(await wilayaOptions.nth(wilayaIndex).innerText()).trim()}`);
        await humanPause(250, 600);

        await page.waitForFunction((selector) => {
            const select = document.querySelector(selector);
            return select && !select.disabled && Array.from(select.options).some(option => option.value);
        }, communeSelector, { timeout: 30000 });
        const communeOptions = commune.locator('option:not([disabled])[value]:not([value=""])');
        const communeCount = await communeOptions.count();
        if (communeCount === 0) {
            throw new Error('No Commune options loaded after selecting the Wilaya.');
        }
        const communeIndex = config.commune === 'random'
            ? Math.floor(Math.random() * communeCount)
            : 0;
        const communeValue = await communeOptions.nth(communeIndex).getAttribute('value');
        await commune.selectOption(communeValue);
        console.log(`Selected commune: ${(await communeOptions.nth(communeIndex).innerText()).trim()}`);
        await humanPause(250, 600);

        // 3. Complete Order.
        if (config.dryRun) {
            console.log('DRY RUN: Success! Form filled.');
        } else {
            console.log('SUBMITTING ORDER!');
            const clicked = await clickSubmit(page);
            if (!clicked) {
                throw new Error('Submit button not found or not clickable.');
            }
            console.log('Submit button clicked. Waiting for in-place submission...');
            try {
                await page.waitForLoadState('networkidle', { timeout: 15000 });
            } catch (error) {
                console.log(`Submission did not reach network idle: ${error.message}`);
            }
            await humanPause(1000, 1500);
            console.log(`SUCCESS: Order submitted at ${page.url()}`);
        }
        return true;

    } catch (error) {
        console.error(`FAILED: ${person.fullName} - ${error.message}`);
        return false;
    } finally {
        if (context) {
            try {
                await context.close();
            } catch (closeError) {
                console.warn(`Could not close order context: ${closeError.message}`);
            }
        }
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

    let browser = await chromium.launch({ headless: false });

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
            if (!browser.isConnected()) {
                console.warn('Browser was closed; launching a replacement browser.');
                browser = await chromium.launch({ headless: false });
            }
            const proxy = pickProxy(proxies, previousProxy);
            previousProxy = proxy;
            console.log(`Attempt ${attempt}/${maxAttempts} for ${person.fullName}.`);
            try {
                success = await placeOrder(browser, config, person, proxy);
            } catch (error) {
                success = false;
                console.error(`Attempt failed unexpectedly: ${error.message}`);
            }
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
