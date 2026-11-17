import {test,expect} from './browser-fixture.mjs';
test('an existing adult reviews and signs the exact current-state grant',async({page})=>{
 test.setTimeout(180000);
 const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto('http://127.0.0.1:19482/');
 await page.evaluate(async()=>{await (await import('/src/loro/app/admission-bootstrap-browser.mjs')).run({secondAdmission:true})});
 expect(errors).toEqual([]);
});
