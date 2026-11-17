import {test,expect} from './browser-fixture.mjs';
test('signed cooking files reject wrong authority bindings before staging',async({page})=>{test.setTimeout(90000);await page.goto('http://127.0.0.1:19482/');const result=await page.evaluate(async()=> (await import('/src/loro/app/admission-bootstrap-browser.mjs')).run());expect(result.result).toBe('PASS')});
