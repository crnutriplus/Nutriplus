import assert from "node:assert/strict";
import test from "node:test";
import { siteAccessDecision } from "../lib/site-access.ts";

const options={mode:"enforced",allowedEmails:"owner@nutriplus.test"};
const req=(path,init={})=>new Request(`https://nutriplus.test${path}`,init);
const cookie={cookie:"nutriplus_crm_session=crm-session-test"};

test("embedded CRM gate exposes only intended routes",()=>{
  assert.equal(siteAccessDecision(req("/api/operations/crm-panel/embed/session",{method:"POST"}),options).allowed,true);
  assert.equal(siteAccessDecision(req("/api/operations/crm-panel/embed/session"),options).allowed,false);
  for(const path of ["/api/operations/crm-panel","/api/operations/crm-panel/products","/api/operations/crm-panel/orders/abc123"])
    assert.equal(siteAccessDecision(req(path,{headers:cookie}),options).allowed,true,path);
  assert.equal(siteAccessDecision(req("/api/operations/crm-panel/orders",{method:"POST",headers:{...cookie,origin:"https://nutriplus.test"}}),options).allowed,true);
  assert.equal(siteAccessDecision(req("/api/operations/crm-panel/orders",{method:"POST",headers:cookie}),options).allowed,false);
  assert.equal(siteAccessDecision(req("/api/operations/crm-panel/orders",{method:"POST",headers:{...cookie,origin:"https://evil.test"}}),options).allowed,false);
  assert.equal(siteAccessDecision(req("/api/operations/crm-panel/orders/abc123/extra",{headers:cookie}),options).allowed,false);
});
