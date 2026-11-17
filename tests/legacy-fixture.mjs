import {test as base,expect} from './browser-fixture.mjs';
// Existing browser suites exercise the archived workspace. Select it explicitly
// before navigation; fresh-workspace coverage uses the regular Playwright test.
export const test=base.extend({page:async({page},use)=>{await page.addInitScript(()=>{if(!localStorage.getItem('creative-cooking-storage-choice-v1'))localStorage.setItem('creative-cooking-storage-choice-v1','legacy')});await use(page)}});
export {expect};
