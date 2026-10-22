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
    const exactSubmitSelector = 'button[type="button"].single-submit[data-pb-section="PBS-nslh041788049115059"][data-pb-value="اطلب الآن"]';
    const selectors = [
        exactSubmitSelector,
        'button.single-submit',
        'button#buy-btn',
        'button#sticky-buy-btn',
        'button:has-text("اطلب الآن")',
        'button:has-text("اطلب الان")'
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

    const roleLocator = page.getByRole('button', { name: /اطلب الان/i }).first();
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
            const frameRole = frame.getByRole('button', { name: /اطلب الان/i }).first();
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
        console.log(`Navigating to ${config.url}...`);
        // Faster loading strategy for slow proxies
        await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        console.log('Waiting for order form to appear...');
        await page.waitForSelector('input[name="extra_fields[custom_field_Id9Dv79YvrMaZAnT]"]', { timeout: 30000 });
        await humanPause(300, 700);

        // 1. Select Product Offer
        const options = await page.locator('.single-variant input[type="radio"]');
        const optionsCount = await options.count();
        if (optionsCount > 0) {
            let finalOfferIndex = config.offerIndex;
            if (config.offerIndex === "random") {
                finalOfferIndex = Math.floor(Math.random() * optionsCount);
                console.log(`Picked random offer index: ${finalOfferIndex}`);
            }
            const selectedOption = options.nth(Number.isInteger(finalOfferIndex) ? finalOfferIndex : 0);
            const optionId = await selectedOption.getAttribute('id');
            if (optionId) {
                await page.locator(`label[for="${optionId}"]`).click({ timeout: 15000, force: true });
            } else {
                await selectedOption.check({ force: true });
            }
            console.log(`Selected offer: ${await selectedOption.getAttribute('value')}`);
            await humanPause(200, 500);
        }

        // 2. Fill Personal Information
        console.log('Filling personal information...');
        const extraFieldSelector = 'input[name="extra_fields[custom_field_Id9Dv79YvrMaZAnT]"]';
        const extraFields = page.locator(extraFieldSelector);
        const extraFieldCount = await extraFields.count();
        if (extraFieldCount < 1) {
            throw new Error('Full name input not found.');
        }
        await humanType(page, extraFields.nth(0), person.fullName);

        // The supplied markup repeats the same name for the phone field. Prefer
        // a telephone input or phone placeholder when the page exposes one.
        const phoneSelector = 'input[type="tel"], input[name*="phone" i], input[placeholder*="الهاتف"], input[placeholder*="phone" i]';
        const phoneFields = page.locator(phoneSelector);
        if (await phoneFields.count()) {
            await humanType(page, phoneFields.first(), person.phoneNumber);
        } else if (extraFieldCount > 1) {
            await humanType(page, extraFields.nth(1), person.phoneNumber);
        } else {
            throw new Error('Phone input not found. The supplied phone markup has the same name as the full-name field.');
        }

        // 3. Select Wilaya (State)
        let finalWilaya = config.wilaya;
        if (config.wilaya === "random") {
            const wilayaOptions = await page.locator('select#countrySelect option:not([disabled])').all();
            const randomWilayaIndex = Math.floor(Math.random() * wilayaOptions.length);
            finalWilaya = await wilayaOptions[randomWilayaIndex].getAttribute('value');
            const wilayaText = await wilayaOptions[randomWilayaIndex].innerText();
            console.log(`Picked random wilaya: ${wilayaText.trim()}`);
        }
        await page.selectOption('select#countrySelect', finalWilaya);
        await humanPause(250, 600);

        // 4. Wait for Commune to load and select
        console.log('Waiting for commune dropdown...');
        const communeSelector = 'select#citySelect';
        await page.waitForFunction(sel => {
            const select = document.querySelector(sel);
            return select && !select.disabled && select.options.length > 1;
        }, communeSelector, { timeout: 15000 });
        
        const communeOptions = await page.locator(`${communeSelector} option:not([disabled])`).all();
        const validCommuneOptions = [];
        for (const option of communeOptions) {
            const value = await option.getAttribute('value');
            if (value) validCommuneOptions.push(option);
        }
        if (validCommuneOptions.length === 0) {
            throw new Error('No commune options loaded after selecting the wilaya.');
        }

        const index = config.commune === "random" ? Math.floor(Math.random() * validCommuneOptions.length) : 0;
        
        let finalCommuneValue;
        if (config.commune === "first" || config.commune === "random") {
             finalCommuneValue = await validCommuneOptions[index].getAttribute('value');
             const communeText = await validCommuneOptions[index].innerText();
             console.log(`Picked commune: ${communeText.trim()}`);
        } else {
             await page.selectOption(communeSelector, { label: config.commune });
             finalCommuneValue = await page.locator(communeSelector).inputValue();
        }
        await page.selectOption(communeSelector, finalCommuneValue);
        await humanPause(250, 600);

        // 5. Select Delivery Type
        const deliverySelector = 'select#delivery-type';
        if (await page.locator(deliverySelector).count()) {
            let finalDeliveryType = config.deliveryType;
            if (config.deliveryType === "random") {
                const deliveryOptions = await page.locator(`${deliverySelector} option:not([disabled])`).all();
                if (deliveryOptions.length > 0) {
                    const randomIndex = Math.floor(Math.random() * deliveryOptions.length);
                    finalDeliveryType = await deliveryOptions[randomIndex].getAttribute('value');
                    console.log(`Picked random delivery type: ${finalDeliveryType}`);
                }
            }
            await page.selectOption(deliverySelector, finalDeliveryType);
        } else {
            console.log('No delivery-type select found; continuing to submit.');
        }
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
    console.log(`Scheduling ${dailyRequestLimit} localhost requests over ${scheduleHours} hours.`);

    for (let requestIndex = 0; requestIndex < dailyRequestLimit; requestIndex++) {
        const person = people[requestIndex % people.length];
        const proxy = proxies.length > 0 ? proxies[Math.floor(Math.random() * proxies.length)] : null;
        console.log(`\n--- Scheduled request ${requestIndex + 1}/${dailyRequestLimit} ---`);
        await placeOrder(browser, config, person, proxy);

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
