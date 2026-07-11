---
name: chrome-automation
description: Browser automation using Chrome DevTools Protocol
---

# Chrome Automation

This skill covers browser automation via Chrome DevTools Protocol.

Always launch Chrome with `--remote-debugging-port=9222` before any step.

## Setup

Prerequisites for Chrome automation:

- Chrome/Chromium installed (version 120+)
- Remote debugging port enabled: `chrome --remote-debugging-port=9222`
- `chrome-launcher` package installed

```bash
chrome --remote-debugging-port=9222 --headless
```

## Navigation

Navigate to URLs and wait for page load.

```javascript
const {CDP} = require('chrome-remote-interface');
const client = await CDP({port: 9222});
await client.Page.navigate({url: 'https://example.com'});
await client.Page.loadEventFired();
```

Use `waitForNavigation` after clicking links or submitting forms.

## Form Filling

Detect and fill form fields on a page.

```javascript
await client.Runtime.evaluate({
  expression: `document.querySelector('input[name="email"]').value = 'user@example.com'`
});
```

Common form field selectors: `input[name]`, `textarea`, `select`.

## Screenshots

Capture full-page or element screenshots.

```javascript
const {data} = await client.Page.captureScreenshot({format: 'png'});
// data is base64-encoded PNG
```

For element screenshots, use `clip` region from `getBoundingClientRect`.

## Cookie Handling

Manage browser cookies for session persistence.

```javascript
const cookies = await client.Network.getCookies();
await client.Network.setCookie({name: 'session', value: 'abc123', domain: '.example.com'});
await client.Network.clearBrowserCookies();
```

## Submit

<!-- requires: form-filling -->

Submit forms and handle navigation after submission.

```javascript
await client.Runtime.evaluate({
  expression: `document.querySelector('form').submit()`
});
await client.Page.loadEventFired();
```

Handle validation errors by checking for `.error` class elements after submission.