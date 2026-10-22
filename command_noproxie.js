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

async function humanPause(min = 150, max = 400) {
  await sleep(randomBetween(min, max));
}

async function humanType(page, selector, value) {
  await page.click(selector, { timeout: 15000 });
  await page.fill(selector, '');
  await page.type(selector, value, { delay: randomBetween(40, 120) });
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
    await locator.evaluate((el) => el.click());
    return true;
  } catch {}
  return false;
}

async function clickSubmit(page) {
  const selectors = [
    'button#orderSubmitButton',
    'button#buy-btn',
    'button#sticky-buy-btn',
    'button[data-button-id="order-with-cod"]',
    'button.leadform-button',
    'button:has-text("اطلب الآن")',
    'button:has-text("إشتري الان")',
    'button:has-text("اطلب الان")'
  ];

  try {
    await page.waitForFunction(() => {
      const button = document.querySelector('#orderSubmitButton');
      return button && !button.disabled;
    }, { timeout: 15000 });
  } catch {}

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

  const exactRoleLocator = page.getByRole('button', { name: /اطلب الآن/i }).first();
  if (await exactRoleLocator.count()) {
    if (await attemptClick(exactRoleLocator)) return true;
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

      const frameExactRole = frame.getByRole('button', { name: /اطلب الآن/i }).first();
      if (await frameExactRole.count()) {
        if (await attemptClick(frameExactRole)) return true;
      }
    }
  }

  return false;
}

async function openProvinceDropdown(page, provinceLocator) {
  await provinceLocator.scrollIntoViewIfNeeded().catch(() => {});
  await provinceLocator.click({ timeout: 15000 });
  await humanPause(300, 700);
}

async function clickCustomSelectByPlaceholder(page, placeholderText) {
  await page.locator('div[data-kt-select-wrapper]').evaluateAll((elements, needle) => {
    const element = elements.find((item) => {
      const text = item.textContent || '';
      const style = window.getComputedStyle(item);
      const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && item.getClientRects().length > 0;
      return isVisible && text.includes(needle);
    });

    if (!element) {
      throw new Error(`Custom select with placeholder ${needle} not found`);
    }

    const display = element.querySelector('[data-kt-select-display]');
    if (!display) {
      throw new Error(`Custom select display for ${needle} not found`);
    }

    display.click();
  }, placeholderText);
  await humanPause(300, 700);
  return true;
}

async function pickProvinceOption(page, config) {
  await clickCustomSelectByPlaceholder(page, 'اختر الولاية');

  const optionSelectors = [
    'li[data-kt-select-option][role="option"]',
    '[role="option"][data-kt-select-option]',
    '.kt-select-option[role="option"]'
  ];

  const optionLocators = [];
  for (const sel of optionSelectors) {
    try {
      const locs = await page.locator(sel).all();
      for (const loc of locs) {
        const text = (await loc.innerText().catch(() => '')).trim();
        if (text) optionLocators.push({ loc, text });
      }
    } catch {}
  }

  if (optionLocators.length === 0) {
    throw new Error('Province dropdown opened but no selectable province options were found');
  }

  if (config.wilaya === 'random') {
    const randomIndex = Math.floor(Math.random() * optionLocators.length);
    const chosen = optionLocators[randomIndex];
    console.log(`Picked random province: ${chosen.text}`);
    await chosen.loc.click({ timeout: 15000 });
    return chosen.text;
  }

  const desired = String(config.wilaya || '').trim();
  const match = optionLocators.find((item) => item.text.includes(desired));
  const chosen = match || optionLocators[0];
  console.log(`Picked province: ${chosen.text}`);
  await chosen.loc.click({ timeout: 15000 });

  await page.waitForFunction(
    (text) => {
      const display = document.querySelector('div[data-kt-select-wrapper] [data-kt-select-placeholder="اختر الولاية"]') ||
        document.querySelector('div[data-kt-select-wrapper] [data-kt-select-display]');
      return display && display.textContent && display.textContent.includes(text);
    },
    chosen.text,
    { timeout: 5000 }
  ).catch(() => {});

  return chosen.text;
}

async function pickCityOption(page, config) {
  await clickCustomSelectByPlaceholder(page, 'اختر البلدية');

  const cityWrapper = page.locator('div[data-kt-select-wrapper]').filter({ hasText: 'اختر البلدية' }).first();
  const cityDropdown = cityWrapper.locator('[data-kt-select-dropdown]').first();
  await cityDropdown.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

  const optionLocators = await cityDropdown.locator('li[data-kt-select-option][role="option"]').all();
  const cityChoices = [];
  for (const opt of optionLocators) {
    try {
      const disabled = await opt.getAttribute('aria-disabled');
      if (disabled === 'true') continue;

      const value = (await opt.getAttribute('data-value')) || '';
      const text = (await opt.getAttribute('data-text').catch(() => '') || (await opt.innerText().catch(() => ''))).trim();
      if (value && text) {
        cityChoices.push({ opt, value, text });
      }
    } catch {}
  }

  if (cityChoices.length === 0) {
    throw new Error('City dropdown opened but no selectable city options were found');
  }

  const desiredCity = String(config.commune || '').trim();
  let chosen = null;
  if (desiredCity && desiredCity !== 'first') {
    chosen = cityChoices.find((item) => item.text.includes(desiredCity)) || null;
  }
  if (!chosen) {
    chosen = cityChoices[0];
  }

  console.log(`Picked city: ${chosen.text}`);
  await chosen.opt.scrollIntoViewIfNeeded().catch(() => {});
  await chosen.opt.click({ timeout: 15000, force: true }).catch(async () => {
    await chosen.opt.evaluate((el) => el.click());
  });

  await page.waitForFunction(
    (selectedText) => {
      const wrapper = document.querySelector('div[data-kt-select-wrapper] [data-kt-select-display]');
      return wrapper && wrapper.textContent && wrapper.textContent.includes(selectedText);
    },
    chosen.text,
    { timeout: 5000 }
  ).catch(() => {});

  await page.waitForFunction(
    (text) => {
      const display = document.querySelector('div[data-kt-select-wrapper] [data-kt-select-display] [data-kt-select-option-text]') ||
        document.querySelector('div[data-kt-select-wrapper] [data-kt-select-display]');
      return display && display.textContent && !display.textContent.includes('اختر البلدية') && display.textContent.includes(text);
    },
    chosen.text,
    { timeout: 5000 }
  ).catch(() => {});
}

async function fetchProxies(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const list = data.split('\n').map((line) => line.trim()).filter(Boolean);
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
    // support host:port:user:pass format (common in some proxy lists)
    const parts = raw.split(':');
    if (parts.length === 4) {
      serverPart = `${parts[0]}:${parts[1]}`;
      username = parts[2];
      password = parts[3];
    } else if (parts.length === 2) {
      serverPart = raw; // host:port
    }
  }

  if (!/^https?:\/\//i.test(serverPart)) {
    // always use http proxy scheme
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
    // Faster loading strategy for slow networks
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    console.log('Waiting for order form to appear...');
    // Support the current form controls and older variants
    await page.waitForSelector('#customerName, #customerPhone, #orderSubmitButton, #customerCity, [data-kt-select-display], form#order-form, form#leadform-submit-form, .leadform-form', { timeout: 30000 });
    await humanPause(300, 700);

    // 1. Select Product Offer
    const options = await page.locator('ul#options li.option');
    const optionsCount = await options.count();
    if (optionsCount > 0) {
      let finalOfferIndex = config.offerIndex;
      if (config.offerIndex === 'random') {
        finalOfferIndex = Math.floor(Math.random() * optionsCount);
        console.log(`Picked random offer index: ${finalOfferIndex}`);
      }
      await options.nth(finalOfferIndex).click();
      await humanPause(200, 500);
    }

    // 2. Fill Personal Information
    console.log('Filling personal information...');
      // Try several selectors (new markup uses name attributes)
      let fullNameSel = null;
      const fullNameCandidates = ['input#customerName', 'input[name="customerName"]', 'input[name="first_name"]', 'input[name="first-name"]', 'input[name="fullName"]', 'input#fullName', 'input[name="full_name"]'];
      for (const s of fullNameCandidates) {
        try {
          if (await page.locator(s).count()) { fullNameSel = s; break; }
        } catch {}
      }
      if (fullNameSel) {
        await humanType(page, fullNameSel, person.fullName);
      } else {
        console.warn('Full name input not found with known selectors');
      }

      let phoneSel = null;
      const phoneCandidates = ['input#customerPhone', 'input[name="customerPhone"]', 'input[name="phone"]', 'input[type="tel"]', 'input#phoneNumber', 'input[name="phoneNumber"]'];
      for (const s of phoneCandidates) {
        try {
          if (await page.locator(s).count()) { phoneSel = s; break; }
        } catch {}
      }
      if (phoneSel) {
        await humanType(page, phoneSel, person.phoneNumber);
      } else {
        console.warn('Phone input not found with known selectors');
      }

    // 3. Select Province then City (dependent selects)
    const provinceSelectors = ['div[data-kt-select-wrapper]:has([data-kt-select-placeholder="اختر الولاية"])', 'div[data-kt-select-display]:has-text("اختر الولاية")', 'select[name="province"]', 'select[name="wilaya"]', 'select#province', 'select#wilaya'];
    const citySelectors = ['div[data-kt-select-wrapper]:has([data-kt-select-placeholder="اختر البلدية"])', 'div[data-kt-select-display]:has-text("اختر البلدية")', '[data-kt-select-placeholder="اختر البلدية"]', '#customerCity', 'select#customerCity', 'select[name="cityID"]', 'select[name="city"]', 'select#city', 'select[name="commune"]', 'select#commune'];

    let provinceSel = null;
    for (const s of provinceSelectors) {
      try { if (await page.locator(s).count()) { provinceSel = s; break; } } catch {}
    }

    let citySel = null;
    for (const s of citySelectors) {
      try { if (await page.locator(s).count()) { citySel = s; break; } } catch {}
    }

    if (!provinceSel) {
      console.warn('Province select not found with known selectors');
    } else {
      const provinceLocator = page.locator(provinceSel).first();
      const isNativeSelect = await provinceLocator.evaluate((el) => el.tagName === 'SELECT').catch(() => false);

      if (isNativeSelect) {
        let finalProvince = config.wilaya || '';
        const provinceOptions = await page.locator(`${provinceSel} option:not([disabled])`).all();
        if (config.wilaya === 'random') {
          const candidates = provinceOptions.filter((o) => o);
          let idx = Math.floor(Math.random() * candidates.length);
          for (let tries = 0; tries < candidates.length && (await candidates[idx].getAttribute('value')) === ''; tries++) {
            idx = Math.floor(Math.random() * candidates.length);
          }
          finalProvince = await candidates[idx].getAttribute('value');
          const provText = await candidates[idx].innerText();
          console.log(`Picked random province: ${provText.trim()}`);
        }
        await page.selectOption(provinceSel, finalProvince);
      } else {
        await pickProvinceOption(page, config);
      }
    }
    // wait 2 seconds after choosing province before selecting city
    await page.waitForTimeout(2000);
    await humanPause(250, 600);

    // wait for city select to populate
    if (!citySel) {
      // try discovering city selector now that province selected
      for (const s of citySelectors) {
        try { if (await page.locator(s).count()) { citySel = s; break; } } catch {}
      }
    }

    if (citySel) {
      await pickCityOption(page, config);
    } else {
      console.warn('City select not found; skipping city selection');
    }
    await humanPause(250, 600);

    // 5. Select Delivery Type (if present)
    if (await page.locator('select#delivery-type').count()) {
      let finalDeliveryType = config.deliveryType;
      if (config.deliveryType === 'random') {
        const deliveryOptions = await page.locator('select#delivery-type option').all();
        if (deliveryOptions.length > 0) {
          const randomIndex = Math.floor(Math.random() * deliveryOptions.length);
          finalDeliveryType = await deliveryOptions[randomIndex].getAttribute('value');
          console.log(`Picked random delivery type: ${finalDeliveryType}`);
        }
      }
      try { await page.selectOption('select#delivery-type', finalDeliveryType); } catch {}
      await humanPause(200, 500);
    } else {
      await humanPause(200, 500);
    }
    await humanPause(200, 500);

    // 7. Complete Order
      if (config.dryRun) {
      console.log('DRY RUN: Success! Form filled.');
    } else {
      console.log('SUBMITTING ORDER!');
      const clicked = await clickSubmit(page);
      if (!clicked) {
        throw new Error('Submit button not found or not clickable.');
      }
      console.log('Clicked submit — waiting 4 seconds before moving to the next entry...');
      await page.waitForTimeout(4000);
    }
    return true;
  } catch (error) {
    console.error(`FAILED: ${person.fullName} - ${error.message}`);
    return false;
  } finally {
    await context.close();
  }
}

function pickProxy(proxies, previousProxy = null) {
  if (proxies.length === 0) return null;
  const candidates = previousProxy && proxies.length > 1
    ? proxies.filter((proxy) => proxy !== previousProxy)
    : proxies;
  return candidates[Math.floor(Math.random() * candidates.length)];
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
  const maxAttempts = Math.max(Number(config.maxAttempts) || 3, 1);

  for (let i = 0; i < people.length; i++) {
    let success = false;
    let previousProxy = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const proxy = pickProxy(proxies, previousProxy);
      previousProxy = proxy;
      console.log(`Attempt ${attempt}/${maxAttempts} for ${people[i].fullName}.`);
      const result = await placeOrder(browser, config, people[i], proxy);
      if (result === true) {
        success = true;
        break;
      } else if (attempt < maxAttempts) {
        console.log('Attempt failed; switching proxy and retrying immediately.');
      }
    }

    if (!success) {
      console.error(`Giving up on ${people[i].fullName} after ${maxAttempts} attempts.`);
    }

    if (i < people.length - 1) {
      console.log('Waiting 5 seconds before moving to next person...');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  console.log('\n--- BATCH COMPLETE ---');
  if (config.dryRun) await new Promise((r) => setTimeout(r, 30000));
  await browser.close();
}

runBot();
