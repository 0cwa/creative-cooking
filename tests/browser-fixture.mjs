import {test as base,expect,chromium} from '@playwright/test';
// Optional CDP support lets local verification reuse an explicitly isolated,
// headless browser. CI uses Playwright's default browser fixture.
export const test=process.env.TEST_CDP_ENDPOINT ? base.extend({browser:async({},use)=>{const browser=await chromium.connectOverCDP(process.env.TEST_CDP_ENDPOINT);await use(browser);await browser.close()}}) : base;
export {expect};
