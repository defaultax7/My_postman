"use strict";
/* Drives the real desktop app through CDP: send, save, env vars, persistence.
   Usage: node test/drive.js ws://127.0.0.1:9222/devtools/page/<id> */
const wsUrl = process.argv[2];
const BASE = process.argv[3] || "http://127.0.0.1:8787";
if (!wsUrl) {
  console.error("usage: node test/drive.js <ws-url> [base-url]");
  process.exit(2);
}
const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(method, params) {
  return new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}
async function evalJs(expression) {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res && res.exceptionDetails) {
    problems.push("eval exception: " + JSON.stringify(res.exceptionDetails.exception && res.exceptionDetails.exception.description || res.exceptionDetails.text));
    return undefined;
  }
  return res && res.result ? res.result.value : undefined;
}
async function waitFor(expression, timeoutMs, label) {
  const deadline = Date.now() + (timeoutMs || 8000);
  while (Date.now() < deadline) {
    if (await evalJs(expression)) return true;
    await sleep(200);
  }
  problems.push("timeout waiting for " + (label || expression));
  return false;
}
function check(name, condition, extra) {
  const detail = extra === undefined ? "" : String(JSON.stringify(extra)).slice(0, 400);
  console.log((condition ? "  PASS " : "  FAIL ") + name + (condition ? "" : " :: " + detail));
  if (!condition) problems.push(name + " " + detail);
}

ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result || m.error);
    pending.delete(m.id);
    return;
  }
  if (m.method === "Runtime.exceptionThrown") {
    problems.push("page exception: " + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text));
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    const text = m.params.args.map((a) => a.value || a.description).join(" ");
    if (!/Amplitude|LaunchDarkly|MaxListeners|DevTools/.test(text)) problems.push("console error: " + text.slice(0, 300));
  }
};

ws.onopen = async () => {
  await send("Runtime.enable");
  await send("Log.enable");

  console.log("boot");
  const booted = await waitFor("typeof S !== 'undefined' && S.collections !== undefined && !!document.querySelector('#btn-send') && Array.isArray(S.tabs)", 15000, "renderer boot");
  check("renderer booted", booted);
  if (!booted) return finish();

  console.log("custom window controls");
  const windowControls = await evalJs("JSON.stringify({min:!!document.querySelector('#btn-minimize'),max:!!document.querySelector('#btn-maximize'),close:!!document.querySelector('#btn-close'),outerDiff:outerHeight-innerHeight})");
  check("minimize/maximize/close controls are in the top bar", /"min":true/.test(windowControls || "") && /"max":true/.test(windowControls || "") && /"close":true/.test(windowControls || ""), windowControls);
  check("top-bar Import/Environments buttons are removed", (await evalJs("!document.querySelector('#btn-import') && !document.querySelector('#btn-manage-env')")) === true);
  check("native title bar is removed", /"outerDiff":[01]/.test(windowControls || ""), windowControls);
  const wasMaximized = await evalJs("api.window.isMaximized()");
  await evalJs("document.querySelector('#btn-maximize').click(); 'ok'");
  await sleep(600);
  const isMaximized = await evalJs("api.window.isMaximized()");
  const maximizeLabel = await evalJs("document.querySelector('#btn-maximize').textContent");
  check("maximize button toggles the window", isMaximized === !wasMaximized && maximizeLabel === (isMaximized ? "❐" : "□"), JSON.stringify({ wasMaximized, isMaximized, maximizeLabel }));
  if (isMaximized !== wasMaximized) {
    await evalJs("document.querySelector('#btn-maximize').click(); 'ok'");
    await sleep(600);
  }

  console.log("resizable sidebar");
  await evalJs("S.settings.sidebarWidth=null;applySidebarWidth(null);saveSettings();'ok'");
  await sleep(200);
  const sidebarDrag = await evalJs("(()=>{const s=document.querySelector('#sidebar');const h=document.querySelector('#sidebar-resizer');const start=s.getBoundingClientRect().width;const r=h.getBoundingClientRect();h.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,clientX:r.left+2,clientY:r.top+50}));document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:r.left+102,clientY:r.top+50}));document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:r.left+102,clientY:r.top+50}));return JSON.stringify({start,width:s.getBoundingClientRect().width,setting:S.settings.sidebarWidth,dragging:h.classList.contains('dragging'),resizing:document.body.classList.contains('resizing-sidebar')})})()");
  const sidebarState = JSON.parse(sidebarDrag || "{}");
  check("dragging the splitter resizes the sidebar", sidebarState.width >= sidebarState.start + 90 && sidebarState.width <= sidebarState.start + 110, sidebarDrag);
  check("sidebar width is saved", Math.abs(sidebarState.setting - sidebarState.width) < 2, sidebarDrag);
  check("sidebar drag ends cleanly", sidebarState.dragging === false && sidebarState.resizing === false, sidebarDrag);
  const sidebarReset = await evalJs("(()=>{document.querySelector('#sidebar-resizer').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}));return JSON.stringify({width:document.querySelector('#sidebar').getBoundingClientRect().width,setting:S.settings.sidebarWidth})})()");
  check("double-click resets the sidebar width", /"width":290/.test(sidebarReset || "") && /"setting":null/.test(sidebarReset || ""), sidebarReset);

  console.log("no automatic empty tab");
  await evalJs("(()=>{S.tabs.slice().forEach(t=>closeTab(t.id));return 'ok'})()");
  await sleep(300);
  check("closing all tabs leaves no blank tab", (await evalJs("S.tabs.length")) === 0 && (await evalJs("S.activeTabId")) === null);
  check("empty workspace is shown", /No request open/.test(await evalJs("document.querySelector('#request-body').innerText")));
  await evalJs("newTab(); 'ok'");
  await sleep(300);
  check("new request reopens the workspace", (await evalJs("S.tabs.length")) === 1 && (await evalJs("document.querySelector('#url').disabled")) === false, await evalJs("JSON.stringify({tabs:S.tabs.length,urlDisabled:document.querySelector('#url').disabled})"));

  console.log("send request through the UI");
  await evalJs(`(()=>{const u=document.querySelector('#url');u.value=${JSON.stringify(BASE + "/hello?x=1")};u.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#btn-send').click();return true})()`);
  await waitFor("document.querySelector('#response-meta .badge')", 10000, "response badge");
  const meta = await evalJs("document.querySelector('#response-meta').innerText");
  const bodyText = await evalJs("document.querySelector('#response-body').innerText");
  check("response 200", /200/.test(meta || ""), meta);
  check("response body rendered", /rea-offline-test/.test(bodyText || ""), bodyText && bodyText.slice(0, 200));
  check("history recorded", (await evalJs("S.history.length")) >= 1);

  console.log("JSON field copy menu");
  const jsonFieldMenu = await evalJs("(()=>{const field=document.querySelector('.json-view [data-json-key=path]');if(!field) return 'missing';field.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:350,clientY:300}));return JSON.stringify({path:field.dataset.jsonPath,labels:[...document.querySelectorAll('.context-menu .context-item')].map(el=>el.textContent.trim())})})()");
  check("JSON field context menu offers copy actions", /Copy value/.test(jsonFieldMenu || "") && /Copy value as JSON/.test(jsonFieldMenu || "") && /Copy JSON path/.test(jsonFieldMenu || ""), jsonFieldMenu);
  await evalJs("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 'ok'");
  await sleep(200);

  console.log("history stores request + response");
  const histSnapshot = await evalJs("JSON.stringify({status:S.history[0].response && S.history[0].response.status, hasBody: !!(S.history[0].response && S.history[0].response.body && S.history[0].response.body.text), size: S.history[0].response && S.history[0].response.body && S.history[0].response.body.size, durationMs: S.history[0].durationMs})");
  check("history snapshot has response", /"status":200/.test(histSnapshot || "") && /"hasBody":true/.test(histSnapshot || ""), histSnapshot);
  await evalJs("S.activePanel='history'; renderSidebar(); 'ok'");
  await sleep(300);
  const histHtml = await evalJs("document.querySelector('#panel-history').innerText");
  check("history list shows status + time", /200/.test(histHtml || "") && /(ms|s)\b/.test(histHtml || ""), (histHtml || "").slice(0, 160));
  const tabsBefore = await evalJs("S.tabs.length");
  await evalJs("(()=>{document.querySelector('#panel-history .hist-item').click();return 'ok'})()");
  await waitFor("(()=>{const m=document.querySelector('#response-meta');return m && /history/.test(m.innerText)})()", 5000, "history response restored");
  const restoredMeta = await evalJs("document.querySelector('#response-meta').innerText");
  const restoredBody = await evalJs("document.querySelector('#response-body').innerText");
  check("history click opened a tab", (await evalJs("S.tabs.length")) === tabsBefore + 1);
  check("restored response marked as history", /history/i.test(restoredMeta || ""), restoredMeta);
  check("restored response body rendered", /rea-offline-test/.test(restoredBody || ""), (restoredBody || "").slice(0, 160));
  await evalJs("closeTab(S.activeTabId); 'ok'");
  await sleep(300);
  await evalJs("S.activePanel='collections'; renderSidebar(); 'ok'");

  console.log("collection + save request");
  await evalJs("void newCollection(); 'ok'");
  await sleep(300);
  await evalJs(`(()=>{const i=document.querySelector('#modal-root input[type=text]');i.value='My API';document.querySelector('#modal-root button.primary').click();return true})()`);
  await sleep(400);
  check("collection created", (await evalJs("S.collections.length")) === 1, await evalJs("JSON.stringify(S.collections.map(c=>c.name))"));
  const collapseAllState = await evalJs("(()=>{const b=[...document.querySelectorAll('#panel-collections .panel-head button')].find(x=>x.title.includes('Collapse all'));if(!b)return 'missing';b.click();const collapsed=S.collections.every(c=>c._open===false);S.collections.forEach(c=>c._open=true);renderCollections();return JSON.stringify({button:!!b,collapsed})})()");
  check("collapse all collections works", /"button":true/.test(collapseAllState || "") && /"collapsed":true/.test(collapseAllState || ""), collapseAllState);
  await evalJs("showSaveModal()");
  await sleep(300);
  await evalJs(`(()=>{const i=document.querySelector('#modal-root input[type=text]');i.value='Hello Request';const sel=document.querySelector('#modal-root select');sel.value=S.collections[0].id;sel.dispatchEvent(new Event('change'));return true})()`);
  await sleep(200);
  await evalJs("document.querySelector('#modal-root button.primary').click()");
  await sleep(500);
  check("request saved into collection", (await evalJs("S.collections[0].items.length")) === 1, await evalJs("JSON.stringify(S.collections[0].items.map(i=>i.name))"));
  check("tab linked to saved item", !!(await evalJs("activeTab().saved && activeTab().saved.collectionId === S.collections[0].id")));

  console.log("saved request tab reuse");
  const tabsBeforeReuse = await evalJs("S.tabs.length");
  const clickSavedRequest = "(()=>{const row=[...document.querySelectorAll('#panel-collections .tree-item')].find(el=>el.textContent.includes('Hello Request')&&el.querySelector('.m'));row.click();return 'ok'})()";
  await evalJs(clickSavedRequest);
  await sleep(300);
  const tabsAfterFirstOpen = await evalJs("S.tabs.length");
  await evalJs(clickSavedRequest);
  await sleep(300);
  const tabsAfterSecondOpen = await evalJs("S.tabs.length");
  check("saved request reuses its existing tab", tabsAfterFirstOpen === tabsBeforeReuse && tabsAfterSecondOpen === tabsBeforeReuse, JSON.stringify({ before: tabsBeforeReuse, first: tabsAfterFirstOpen, second: tabsAfterSecondOpen }));

  console.log("quick save into linked request");
  await evalJs("(()=>{const t=activeTab();t.request.headers.push({key:'X-Quick-Save',value:'1',enabled:true});markDirty(t);return 'ok'})()");
  await evalJs("document.querySelector('#btn-save').click(); 'ok'");
  await sleep(500);
  check("quick save does not open the dialog", (await evalJs("document.querySelector('#modal-root').classList.contains('open')")) === false);
  check("quick save updates the linked collection request", (await evalJs("S.collections[0].items[0].request.headers.some(h=>h.key==='X-Quick-Save'&&h.value==='1')")) === true);
  check("quick save clears the dirty state", (await evalJs("activeTab().dirty")) === false);
  await evalJs("newTab(); 'ok'");
  await sleep(300);
  await evalJs("document.querySelector('#btn-save').click(); 'ok'");
  await sleep(300);
  check("save for an unsaved tab still asks for a destination", (await evalJs("document.querySelector('#modal-root').classList.contains('open')")) === true);
  await evalJs("(()=>{const b=[...document.querySelectorAll('#modal-root button')].find(x=>x.textContent.trim()==='Cancel');if(b)b.click();return 'ok'})()");
  await sleep(200);
  await evalJs("closeTab(S.activeTabId); 'ok'");
  await sleep(300);

  console.log("header autocomplete");
  await evalJs("(()=>{const t=activeTab();t.requestSubTab='headers';renderRequestPane();return 'ok'})()");
  await sleep(250);
  await evalJs("(()=>{const b=[...document.querySelectorAll('#request-body button')].find(x=>x.textContent.includes('Add header'));b.click();return 'ok'})()");
  await sleep(250);
  const headerAutocomplete = await evalJs("(()=>{const input=document.querySelector('#request-body .kv-table input[type=text]');const id=input&&input.getAttribute('list');const list=id&&document.getElementById(id);return JSON.stringify({hasList:!!id,count:list?list.options.length:0,hasContentType:list?[...list.options].some(o=>o.value==='Content-Type'):false,hasAuthorization:list?[...list.options].some(o=>o.value==='Authorization'):false,hasApiKey:list?[...list.options].some(o=>o.value==='X-API-Key'):false})})()");
  check("header key autocomplete is available", /"hasList":true/.test(headerAutocomplete || "") && /"hasContentType":true/.test(headerAutocomplete || "") && /"hasAuthorization":true/.test(headerAutocomplete || "") && /"hasApiKey":true/.test(headerAutocomplete || ""), headerAutocomplete);
  await evalJs("(()=>{const t=activeTab();t.request.headers=t.request.headers.filter(h=>h.key||h.value);t.requestSubTab='params';t.dirty=false;renderAll();return 'ok'})()");
  await sleep(200);

  console.log("right-click context menus");
  const requestMenuLabels = await evalJs("(()=>{const row=[...document.querySelectorAll('#panel-collections .tree-item')].find(el=>el.textContent.includes('Hello Request')&&el.querySelector('.m'));row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:160}));return [...document.querySelectorAll('.context-menu .context-item')].map(el=>el.textContent.trim()).join('|')})()");
  check("request context menu has actions", /Docs/.test(requestMenuLabels || "") && /Duplicate/.test(requestMenuLabels || "") && /Rename/.test(requestMenuLabels || "") && /Delete/.test(requestMenuLabels || ""), requestMenuLabels);
  check("collection tree has no inline action buttons", (await evalJs("document.querySelectorAll('#panel-collections .row-actions').length")) === 0);
  await evalJs("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 'ok'");
  await sleep(200);
  check("Escape closes context menu", (await evalJs("document.querySelectorAll('.context-menu').length")) === 0);
  const collectionMenuLabels = await evalJs("(()=>{const row=[...document.querySelectorAll('#panel-collections .tree-item')].find(el=>el.querySelector('b')&&el.textContent.includes('My API'));row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:130}));return [...document.querySelectorAll('.context-menu .context-item')].map(el=>el.textContent.trim()).join('|')})()");
  check("collection context menu has actions", /Run collection/.test(collectionMenuLabels || "") && /New folder/.test(collectionMenuLabels || "") && /Export/.test(collectionMenuLabels || "") && /Delete/.test(collectionMenuLabels || ""), collectionMenuLabels);
  await evalJs("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 'ok'");
  await sleep(200);

  console.log("long collection/request names");
  await evalJs("(()=>{const c=S.collections[0];c._oldName=c.name;c.items[0]._oldName=c.items[0].name;c.name='A very long collection name that should be truncated instead of wrapping';c.items[0].name='A very long request name that should be truncated instead of wrapping';renderCollections();return 'ok'})()");
  await sleep(200);
  const longNameState = await evalJs("(()=>{const col=document.querySelector('#panel-collections .tree-item b.tree-name');const req=[...document.querySelectorAll('#panel-collections .tree-name')].find(el=>el.title.startsWith('A very long request'));const style=getComputedStyle(req);return JSON.stringify({colTitle:col.title,colOverflow:getComputedStyle(col).textOverflow,colTruncated:col.scrollWidth>col.clientWidth,reqTitle:req.title,reqOverflow:style.textOverflow,reqWhiteSpace:style.whiteSpace,reqTruncated:req.scrollWidth>req.clientWidth,rowHeight:req.closest('.tree-item').getBoundingClientRect().height})})()");
  check("long names use ellipsis", /colOverflow":"ellipsis"/.test(longNameState || "") && /reqOverflow":"ellipsis"/.test(longNameState || "") && /reqWhiteSpace":"nowrap"/.test(longNameState || ""), longNameState);
  check("truncated names keep full hover title", /colTruncated":true/.test(longNameState || "") && /reqTruncated":true/.test(longNameState || "") && /A very long request name that should be truncated instead of wrapping/.test(longNameState || ""), longNameState);
  await evalJs("(()=>{const c=S.collections[0];c.name=c._oldName;delete c._oldName;const req=c.items[0];req.name=req._oldName;delete req._oldName;renderCollections();return 'ok'})()");
  await sleep(200);

  console.log("URL variable highlighting + ctrl+click");
  await evalJs("newTab(); 'ok'");
  await sleep(300);
  const variableTabId = await evalJs("S.activeTabId");
  await evalJs("(()=>{const t=activeTab();t.sessionVariables={host:'example.com'};t.request.url='{{host}}/{{missing}}';document.querySelector('#url').value=t.request.url;renderUrlHighlight();return 'ok'})()");
  const urlTokens = await evalJs("JSON.stringify([...document.querySelectorAll('#url-highlight .url-var')].map(el=>({name:el.dataset.var,cls:el.className,color:getComputedStyle(el).color})))");
  check("resolved URL variable is green", /"name":"host","cls":"url-var set"/.test(urlTokens || ""), urlTokens);
  check("unresolved URL variable is red", /"name":"missing","cls":"url-var unset"/.test(urlTokens || ""), urlTokens);
  const variableEditor = await evalJs("(()=>{const token=[...document.querySelectorAll('#url-highlight .url-var')].find(el=>el.dataset.var==='host');const rect=token.getBoundingClientRect();document.querySelector('#url').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,ctrlKey:true,clientX:rect.left+3,clientY:rect.top+3}));const pop=document.querySelector('.var-popover');return JSON.stringify({open:!!pop,value:pop?pop.querySelector('input').value:null,text:pop?pop.innerText:''})})()");
  check("Ctrl+click opens variable editor", /"open":true/.test(variableEditor || "") && /"value":"example\.com"/.test(variableEditor || ""), variableEditor);
  check("variable editor shows its source", /Source: Session/.test(variableEditor || ""), variableEditor);
  await evalJs("(()=>{const pop=document.querySelector('.var-popover');pop.querySelector('input').value='example.org';pop.querySelector('button.primary').click();return 'ok'})()");
  await sleep(300);
  check("variable editor saved a new value", (await evalJs("activeTab().sessionVariables.host")) === "example.org");
  check("edited variable stays resolved", (await evalJs("document.querySelector('#url-highlight .url-var').className")) === "url-var set");
  await evalJs(`closeTab(${JSON.stringify(variableTabId)}); 'ok'`);
  await sleep(300);

  console.log("environment + variables");
  await evalJs("void editEnvironment(null); 'ok'");
  await sleep(300);
  await evalJs(`(()=>{const i=document.querySelector('#modal-root input[type=text]');i.value='Local';const add=[...document.querySelectorAll('#modal-root .modal-body button')].find(b=>b.textContent.includes('Add variable'));add.click();return true})()`);
  await sleep(250);
  await evalJs(`(()=>{const rows=document.querySelectorAll('#modal-root .kv-table tr');const r=rows[rows.length-1];const ins=r.querySelectorAll('input[type=text]');ins[0].value='host';ins[0].dispatchEvent(new Event('input',{bubbles:true}));ins[1].value=${JSON.stringify(BASE)};ins[1].dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await evalJs("document.querySelector('#modal-root button.primary').click()");
  await sleep(500);
  check("environment created", (await evalJs("S.environments.length")) === 1, await evalJs("JSON.stringify(S.environments.map(e=>e.name))"));
  await evalJs(`(()=>{const sel=document.querySelector('#env-select');sel.value=S.environments[0].id;sel.dispatchEvent(new Event('change'));return true})()`);
  await sleep(200);
  await evalJs("newTab()");
  await sleep(300);
  await evalJs(`(()=>{const u=document.querySelector('#url');u.value='{{host}}/hello?var=1';u.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#btn-send').click();return true})()`);
  await waitFor("document.querySelector('#response-body').innerText.includes('rea-offline-test')", 10000, "variable response");
  const varBody = await evalJs("document.querySelector('#response-body').innerText");
  check("{{host}} variable resolved", /rea-offline-test/.test(varBody || ""), varBody && varBody.slice(0, 160));
  const noMissing = !/Unresolved variables/.test(varBody || "");
  check("no unresolved variables", noMissing);

  console.log("scripts");
  await evalJs(`(()=>{const t=activeTab();t.request.scripts.tests="pm.test('status 200',()=>pm.response.to.have.status(200));pm.test('ok true',()=>pm.expect(pm.response.json().ok).to.be.true);";t.request.scripts.preRequest="pm.environment.set('scripted','yes');";document.querySelector('#btn-send').click();return true})()`);
  await waitFor("activeTab().testResults && activeTab().testResults.length >= 2", 10000, "tests");
  const tests = await evalJs("JSON.stringify(activeTab().testResults)");
  check("tests ran + passed", /"passed":true/.test(tests || "") && !/"passed":false/.test(tests || ""), tests);
  const envScripted = await evalJs("(S.environments[0].values||[]).some(v=>v.key==='scripted'&&v.value==='yes')");
  check("pre-request mutated environment", !!envScripted);

  console.log("drag & drop move + duplicate");
  await evalJs("duplicateItem(S.collections[0], S.collections[0].items[0]); 'ok'");
  await sleep(400);
  let names = await evalJs("JSON.stringify(S.collections[0].items.map(i=>i.name))");
  check("duplicate item added", (await evalJs("S.collections[0].items.length")) === 2, names);
  await evalJs("(()=>{const c=S.collections[0];const a=c.items[0].id,b=c.items[1].id;c.items[1].name='Duplicate A';moveNode({kind:'item',collectionId:c.id,itemId:b},{kind:'item',collectionId:c.id,itemId:a,position:'before'});return 'ok'})()");
  await sleep(300);
  names = await evalJs("JSON.stringify(S.collections[0].items.map(i=>i.name))");
  check("item reordered before target", /^\["Duplicate A",/.test(names || ""), names);
  await evalJs("duplicateCollection(S.collections[0]); 'ok'");
  await sleep(300);
  check("collection duplicated", (await evalJs("S.collections.length")) === 2);
  await evalJs("(()=>{const a=S.collections[0].id,b=S.collections[1].id;moveNode({kind:'collection',collectionId:b},{kind:'collection',collectionId:a,position:'before'});return 'ok'})()");
  await sleep(300);
  const order = await evalJs("JSON.stringify(S.collections.map(c=>c.name))");
  check("collection reordered", /copy/.test(order.split(",")[0] || ""), order);
  await evalJs("(()=>{const dup=S.collections.find(c=>/copy/.test(c.name)); S.collections=S.collections.filter(c=>c!==dup); saveCollections(); renderCollections(); return 'ok'})()");
  await sleep(200);

  console.log("descriptions + docs rendering");
  await evalJs("(()=>{S.collections[0].description='# My API\\n\\nUse **v2** endpoints.\\n\\n- one\\n- two'; return 'ok'})()");
  await evalJs("openDocsModal(S.collections[0], S.collections[0], 'collection'); 'ok'");
  await sleep(300);
  const docsHtml = await evalJs("document.querySelector('#modal-root .docs-view').innerHTML");
  check("markdown heading rendered", /<h1>My API<\/h1>/.test(docsHtml || ""), docsHtml && docsHtml.slice(0, 200));
  check("markdown bold + list rendered", /<b>v2<\/b>/.test(docsHtml || "") && /<li>one<\/li>/.test(docsHtml || ""), docsHtml && docsHtml.slice(0, 300));
  check("contents index lists requests", /Hello Request/.test(docsHtml || ""));
  await evalJs("document.querySelector('#modal-root button.primary').click()");
  await sleep(300);
  check("description saved", (await evalJs("S.collections[0].description.includes('Use **v2**')")) === true);

  console.log("collection runner");
  await evalJs("openRunnerModal({collection:S.collections[0], folder:null}); 'ok'");
  await sleep(400);
  await evalJs("(()=>{const inputs=document.querySelectorAll('#modal-root .modal-body input[type=number]');inputs[0].value=2;inputs[0].dispatchEvent(new Event('input',{bubbles:true}));return 'ok'})()");
  await evalJs("(()=>{const b=[...document.querySelectorAll('#modal-root button')].find(x=>x.textContent.trim()==='Run');b.click();return 'ok'})()");
  await waitFor("(()=>{const h=[...document.querySelectorAll('#modal-root .runner .hint')].pop();return h && /Done:|Stopped/.test(h.textContent)})()", 30000, "runner completion");
  const runSummary = await evalJs("(()=>{const h=[...document.querySelectorAll('#modal-root .runner .hint')].pop();return h?h.textContent:''})()");
  check("runner executed 2 iterations x 2 requests", /4 request\(s\)/.test(runSummary || "") && /0 error/.test(runSummary || ""), runSummary);
  check("runner results table has 4 rows", (await evalJs("document.querySelectorAll('#modal-root .runner-table tr').length")) === 4, await evalJs("document.querySelectorAll('#modal-root .runner-table tr').length"));
  check("runner enabled report export", (await evalJs("(()=>{const b=[...document.querySelectorAll('#modal-root button')].find(x=>x.textContent.trim()==='Report JSON');return b && !b.disabled})()")) === true);
  await evalJs("(()=>{const b=[...document.querySelectorAll('#modal-root button')].find(x=>x.textContent.trim()==='Close');if(b)b.click();return 'ok'})()");
  await sleep(300);

  console.log("import Postman v1 workspace");
  const v1Workspace = {
    collections: [{
      id: "wc1", name: "V1 In", description: "legacy", order: ["wr1"],
      folders: [],
      requests: [{ id: "wr1", name: "V1 Request", method: "GET", url: "https://example.com/legacy?z=9", headers: "X-L: 1" }],
    }],
    environments: [{ name: "V1 Env", values: [{ key: "a", value: "1", enabled: true }] }],
    globals: [{ key: "g1", value: "x", enabled: true }],
  };
  await evalJs("openImportModal(); 'ok'");
  await sleep(300);
  await evalJs(`(()=>{document.querySelector('#modal-root textarea').value=${JSON.stringify(JSON.stringify(v1Workspace))};return 'ok'})()`);
  await evalJs("(()=>{const b=[...document.querySelectorAll('#modal-root button')].find(x=>x.textContent.trim()==='Import');b.click();return 'ok'})()");
  await sleep(800);
  check("v1 collection imported via UI", (await evalJs("S.collections.some(c=>c.name==='V1 In')")) === true, await evalJs("JSON.stringify(S.collections.map(c=>c.name))"));
  check("v1 environment imported via UI", (await evalJs("S.environments.some(e=>e.name==='V1 Env')")) === true, await evalJs("JSON.stringify(S.environments.map(e=>e.name))"));
  check("v1 import kept query params", (await evalJs("(()=>{const c=S.collections.find(c=>c.name==='V1 In');return c.items[0].request.params[0].key==='z'})()")) === true);

  console.log("open imported request");
  const tabsBeforeImportOpen = await evalJs("S.tabs.length");
  const clickedImported = await evalJs("(()=>{const row=[...document.querySelectorAll('#panel-collections .tree-item')].find(el=>el.textContent.includes('V1 Request')&&!el.textContent.includes('🗀'));if(!row) return 'missing';row.click();return 'clicked'})()");
  await sleep(400);
  check("imported request row found", clickedImported === "clicked", clickedImported);
  check("imported request opened a tab", (await evalJs("S.tabs.length")) === tabsBeforeImportOpen + 1);
  check("opened request has TLS defaults", (await evalJs("!!(activeTab().request.settings.tls && typeof activeTab().request.settings.tls === 'object')")) === true, await evalJs("JSON.stringify(activeTab().request.settings)"));
  await evalJs("closeTab(S.activeTabId); 'ok'");
  await sleep(200);

  console.log("global SSL bypass setting");
  await evalJs("openAppSettings(); 'ok'");
  await sleep(300);
  const settingsModal = await evalJs("(()=>{const m=document.querySelector('#modal-root');return JSON.stringify({open:m.classList.contains('open'),checkbox:!!m.querySelector('.settings-option input[type=checkbox]'),text:m.innerText})})()");
  check("settings dialog has SSL bypass option", /"open":true/.test(settingsModal || "") && /"checkbox":true/.test(settingsModal || "") && /Bypass SSL certificate verification/.test(settingsModal || ""), settingsModal);
  await evalJs("(()=>{const c=document.querySelector('#modal-root .settings-option input');c.checked=true;[...document.querySelectorAll('#modal-root button')].find(b=>b.textContent.trim()==='Save').click();return 'ok'})()");
  await sleep(400);
  check("global SSL bypass saved", (await evalJs("S.settings.bypassTls")) === true);
  check("settings button marks active bypass", (await evalJs("document.querySelector('#btn-settings').classList.contains('ssl-bypass-on')")) === true);
  await evalJs("S.settings.bypassTls=false;saveSettings();refreshSettingsButton();'ok'");
  await sleep(200);

  console.log("TLS settings UI + mTLS send through IPC");
  const os = require("os");
  const fs = require("fs");
  const https = require("https");
  const { execFileSync } = require("child_process");
  let mtlsOk = false;
  try {
    const dir = fs.mkdtempSync(require("path").join(os.tmpdir(), "repl-drive-certs-"));
    const run = (args) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
    run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-subj", "/CN=Drive Test CA"]);
    run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=localhost"]);
    fs.writeFileSync(`${dir}/san.cnf`, "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n");
    run(["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.crt", "-days", "2", "-extfile", "san.cnf"]);
    run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "client.key", "-out", "client.csr", "-subj", "/CN=drive-client"]);
    fs.writeFileSync(`${dir}/client.cnf`, "extendedKeyUsage=clientAuth\n");
    run(["x509", "-req", "-in", "client.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "client.crt", "-days", "2", "-extfile", "client.cnf"]);
    const tlsServer = https.createServer(
      { key: fs.readFileSync(`${dir}/server.key`), cert: fs.readFileSync(`${dir}/server.crt`), ca: fs.readFileSync(`${dir}/ca.crt`), requestCert: true, rejectUnauthorized: true },
      (req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, client: req.socket.getPeerCertificate().subject.CN })); }
    );
    await new Promise((r) => tlsServer.listen(0, "127.0.0.1", r));
    const tlsUrl = `https://localhost:${tlsServer.address().port}/hello`;
    await evalJs("newTab(); 'ok'");
    await sleep(300);
    await evalJs(`(()=>{const t=activeTab();t.request.url=${JSON.stringify(tlsUrl)};t.request.settings.tls={clientCert:true,type:'pem',certPath:${JSON.stringify(dir + "/client.crt")},keyPath:${JSON.stringify(dir + "/client.key")},caPath:${JSON.stringify(dir + "/ca.crt")},pfxPath:'',passphrase:''};t.requestSubTab='settings';document.querySelector('#url').value=t.request.url;renderRequestPane();return 'ok'})()`);
    await sleep(300);
    const settingsHtml = await evalJs("document.querySelector('#request-body').innerText");
    check("TLS settings section rendered", /Client certificate/i.test(settingsHtml || "") && /Custom CA/i.test(settingsHtml || ""), (settingsHtml || "").slice(0, 200));
    await evalJs("document.querySelector('#btn-send').click(); 'ok'");
    await waitFor("document.querySelector('#response-meta .badge')", 15000, "mTLS response");
    const meta = await evalJs("document.querySelector('#response-meta').innerText");
    const body = await evalJs("document.querySelector('#response-body').innerText");
    check("mTLS send via UI got 200", /200/.test(meta || ""), meta);
    check("server saw client cert CN", /drive-client/.test(body || ""), (body || "").slice(0, 160));
    mtlsOk = true;
    tlsServer.close();
  } catch (e) {
    console.log("  SKIP GUI mTLS (openssl unavailable or failed):", e.message.slice(0, 160));
  }

  console.log("persistence (reload)");
  await evalJs("newTab(); 'ok'");
  await sleep(200);
  await evalJs("saveSession()");
  await sleep(400);
  await evalJs("location.reload()");
  await sleep(1500);
  const restored = await waitFor("typeof S !== 'undefined' && S.collections.length >= 1 && S.environments.length >= 1 && Array.isArray(S.tabs)", 15000, "reload boot");
  check("state restored after reload", restored);
  check("blank tabs are not restored", (await evalJs("S.tabs.some(t=>!t.saved&&!t.dirty&&!t.request.url)")) === false, await evalJs("JSON.stringify(S.tabs.map(t=>({name:t.name,url:t.request.url,saved:t.saved})))"));
  const state = await evalJs("JSON.stringify({tabs:S.tabs.length, cols:S.collections.length, items:S.collections[0].items.length, envs:S.environments.length, history:S.history.length})");
  console.log("       state:", state);

  console.log("tab right-click close actions");
  await evalJs("newTab(); newTab(); 'ok'");
  await sleep(300);
  const tabMenuLabels = await evalJs("(()=>{const tabs=[...document.querySelectorAll('#tabs .tab')];tabs[tabs.length-1].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:45}));return [...document.querySelectorAll('.context-menu .context-item')].map(el=>el.textContent.trim()).join('|')})()");
  check("tab context menu has close actions", /Close other tabs/.test(tabMenuLabels || "") && /Close all tabs/.test(tabMenuLabels || ""), tabMenuLabels);
  await evalJs("(()=>{const b=[...document.querySelectorAll('.context-menu .context-item')].find(el=>el.textContent.includes('Close other tabs'));b.click();return 'ok'})()");
  await sleep(400);
  check("close other tabs keeps one tab", (await evalJs("S.tabs.length")) === 1, await evalJs("S.tabs.length"));
  const singleTabMenu = await evalJs("(()=>{const tab=document.querySelector('#tabs .tab');tab.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:45}));const b=[...document.querySelectorAll('.context-menu .context-item')].find(el=>el.textContent.includes('Close other tabs'));return JSON.stringify({disabled:b.disabled,labels:[...document.querySelectorAll('.context-menu .context-item')].map(el=>el.textContent.trim())})})()");
  check("close other tabs is disabled with one tab", /"disabled":true/.test(singleTabMenu || ""), singleTabMenu);
  await evalJs("(()=>{const b=[...document.querySelectorAll('.context-menu .context-item')].find(el=>el.textContent.includes('Close all tabs'));b.click();return 'ok'})()");
  await sleep(400);
  check("close all tabs leaves no tabs", (await evalJs("S.tabs.length")) === 0 && (await evalJs("S.activeTabId")) === null);
  check("close all tabs shows the empty workspace", /No request open/.test(await evalJs("document.querySelector('#request-body').innerText")));

  finish();
};

function finish() {
  console.log(problems.length ? `\n${problems.length} problem(s): ${problems.slice(0, 8).join(" | ")}` : "\nGUI drive: all checks passed");
  ws.close();
  process.exit(problems.length ? 1 : 0);
}

ws.onerror = (e) => {
  console.error("WS error", e && e.message);
  process.exit(2);
};
