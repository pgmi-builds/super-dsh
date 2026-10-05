import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAiCatalogPath, readEffectiveProviderStore } from '../dist/codex-oauth.js';
import { readProvidersView, syncFromNative, normalizeSaveRequest, removeProviderEntry, saveProvider } from '../dist/codex-provider-gateway.js';
import { readProviderStore, providerStorePath, writeProviderStore, removeProvider } from '../dist/codex-providers.js';
import { providerSdkLaunch } from '../dist/codex-sdk-launch.js';
// Unit fixture based on Codex ModelInfo required fields; these test slugs are not
// evidence that any account or real binary serves the models.
function cacheModel(overrides = {}) {
 return {slug:'official-sol',display_name:'Official SOL',description:null,
  supported_reasoning_levels:[{effort:'medium',description:'Balanced'}],
  shell_type:'unified_exec',visibility:'list',supported_in_api:true,priority:0,
  support_verbosity:true,truncation_policy:{mode:'tokens',limit:10000},
  experimental_supported_tools:[],base_instructions:'Unit-test model instructions',context_window:272000,...overrides};
}
function fixture() {
 const world=mkdtempSync(join(tmpdir(),'superd-oauth-world-'));
 const native=mkdtempSync(join(tmpdir(),'superd-oauth-native-'));
 writeFileSync(join(native,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'test-secret',refresh_token:'test-refresh'}}));
 writeFileSync(join(native,'config.toml'),'model_provider = "custom"\nmodel = "third-model"\nmodel_catalog_json = "third.json"\n[model_providers.custom]\nbase_url = "https://example.test/v1"\nwire_api = "responses"\nenv_key = "TEST_KEY"\n');
 writeFileSync(join(native,'third.json'),JSON.stringify({models:[{slug:'third-model'}]}));
 writeFileSync(join(native,'models_cache.json'),JSON.stringify({models:[cacheModel(),cacheModel({slug:'internal-model',visibility:'hide'})]}));
 return {world,native};
}
test('OAuth discovery persists only native identity and offers official cached models beside third-party config',()=>{
 const {world,native}=fixture(); const config=readFileSync(join(native,'config.toml'));const auth=readFileSync(join(native,'auth.json'));
 const view=readProvidersView(world,native);const oauth=view.providers.find(p=>p.id==='openai-oauth');
 assert.ok(oauth,'OpenAI OAuth missing'); assert.equal(oauth.label,'OpenAI OAuth');assert.equal(oauth.authKind,'oauth');
 assert.deepEqual(oauth.models,[{id:'official-sol',displayName:'Official SOL',contextWindow:272000}]);assert.equal(oauth.hasKey,true);assert.equal(oauth.baseUrl,undefined);
 assert.ok(view.providers.some(p=>p.id==='custom'));
 const stored=JSON.parse(readFileSync(providerStorePath(world),'utf8')).providers.find(p=>p.id==='openai-oauth');
 assert.deepEqual(stored,{id:'openai-oauth',label:'OpenAI OAuth',kind:'openai-oauth',origin:'native'});
 assert.deepEqual(readFileSync(join(native,'config.toml')),config);assert.deepEqual(readFileSync(join(native,'auth.json')),auth);
 const again=readProvidersView(world,native);assert.deepEqual(again.providers,view.providers);
});
test('official launch pins builtin provider and official catalog without synthetic key or third-party catalog',()=>{
 const {world,native}=fixture();syncFromNative(world,native);const entry=readProviderStore(world).providers.find(p=>p.id==='openai-oauth');assert.ok(entry);
 const launch=providerSdkLaunch(world,native,entry);
 assert.equal(launch.providerId,'openai');assert.deepEqual(launch.env,{});
 assert.deepEqual(launch.config,{model_provider:'openai',openai_base_url:'',model_catalog_json:join(native,'models_cache.json')});
});
test('OAuth logout removes only discovered route and malformed credentials do not create a provider',()=>{
 const {world,native}=fixture();readProvidersView(world,native);writeFileSync(join(native,'auth.json'),'{invalid');
 assert.ok(!readProvidersView(world,native).providers.some(p=>p.id==='openai-oauth'));
 assert.ok(readProviderStore(world).providers.some(p=>p.id==='custom'));
 writeFileSync(join(native,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{}}));assert.ok(!readProvidersView(world,native).providers.some(p=>p.id==='openai-oauth'));
});
test('official config model is fallback when cache is unavailable, never third-party configured model',()=>{
 const {world,native}=fixture();writeFileSync(join(native,'models_cache.json'),'{}');
 assert.deepEqual(readProvidersView(world,native).providers.find(p=>p.id==='openai-oauth')?.models,[]);
 writeFileSync(join(native,'config.toml'),'model = "official-local-default"\n');
 assert.deepEqual(readProvidersView(world,native).providers.find(p=>p.id==='openai-oauth')?.models,[{id:'official-local-default'}]);
});
test('discovered OAuth identity is read-only through provider mutations',()=>{
 const {world,native}=fixture();readProvidersView(world,native);
 assert.throws(()=>normalizeSaveRequest({provider:{id:'openai-oauth',label:'Override',baseUrl:'https://example.test',protocol:'responses',models:[],auth:{kind:'apiKey',value:'test'}}}),/native|OAuth|reserved/i);
 assert.throws(()=>removeProviderEntry(world,native,{id:'openai-oauth'}),/native|OAuth|read.only/i);
});

for (const key of ['  model_catalog_json', '  "model_catalog_json"', "  'model_catalog_json'", 'profiles.work.model_catalog_json']) {
 test(`official launch rejects inherited custom catalog spelling ${key} without cache`,()=>{
  const {world,native}=fixture();syncFromNative(world,native);
  const entry=readProviderStore(world).providers.find(p=>p.id==='openai-oauth');
  writeFileSync(join(native,'models_cache.json'),'{}');
  writeFileSync(join(native,'config.toml'),`model_provider = "openai"\n${key} = "third.json"\n`);
  assert.throws(()=>providerSdkLaunch(world,native,entry),/cache/i);
 });
}
test('official launch rejects a profile catalog without cache',()=>{
 const {world,native}=fixture();syncFromNative(world,native);
 const entry=readProviderStore(world).providers.find(p=>p.id==='openai-oauth');
 writeFileSync(join(native,'models_cache.json'),'{}');
 writeFileSync(join(native,'config.toml'),'model_provider = "openai"\nprofile = "work"\n[profiles.work]\n  "model_catalog_json" = "third.json"\n');
 assert.throws(()=>providerSdkLaunch(world,native,entry),/cache/i);
});
for (const [label,models] of [
 ['slug-only',[{slug:'official-sol'}]],
 ['empty slug',[cacheModel({slug:''})]],
 ['empty catalog',[]],
 ['missing metadata',[(({shell_type,...rest})=>rest)(cacheModel())]],
 ['missing native instructions',[(({base_instructions,...rest})=>rest)(cacheModel())]],
 ['non-string enum',[cacheModel({shell_type:['unified_exec']})]],
 ['bad reasoning metadata',[cacheModel({supported_reasoning_levels:[{effort:'medium'}]})]],
 ['bad truncation metadata',[cacheModel({truncation_policy:{mode:'tokens'}})]],
 ['mixed valid and invalid',[cacheModel(),{slug:'incomplete'}]],
]) {
 test(`official launch never injects ${label} cache`,()=>{
  const {world,native}=fixture();syncFromNative(world,native);
  const entry=readProviderStore(world).providers.find(p=>p.id==='openai-oauth');
  writeFileSync(join(native,'models_cache.json'),JSON.stringify({models}));
  assert.equal(openAiCatalogPath(native),undefined);
  assert.throws(()=>providerSdkLaunch(world,native,entry),/cache/i);
  writeFileSync(join(native,'config.toml'),'model_provider = "openai"\nmodel = "official-local-default"\n');
  const launch=providerSdkLaunch(world,native,entry);
  assert.equal(launch.config.model_catalog_json,undefined);
  assert.deepEqual(readProvidersView(world,native).providers.find(p=>p.id==='openai-oauth')?.models,[{id:'official-local-default'}]);
 });
}

test('quoted native third-party selection cannot supply an official default without cache',()=>{
 const {world,native}=fixture();syncFromNative(world,native);
 const entry=readProviderStore(world).providers.find(p=>p.id==='openai-oauth');
 writeFileSync(join(native,'models_cache.json'),'{}');
 writeFileSync(join(native,'config.toml'),'  "model_provider" = "custom"\nmodel = "third-model"\n');
 assert.throws(()=>providerSdkLaunch(world,native,entry),/cache/i);
 assert.deepEqual(readProvidersView(world,native).providers.find(p=>p.id==='openai-oauth')?.models,[]);
});

const COLLIDING_PROVIDER = {id:'openai-oauth',label:'Existing third-party',baseUrl:'https://legacy.example.test/v1',protocol:'responses',auth:{kind:'apiKey',value:'test-legacy-secret'},models:[{id:'legacy-model'}],origin:'user'};
test('an existing third-party OAuth alias keeps its secret and route without a duplicate OAuth identity',()=>{
 const {world,native}=fixture();
 writeProviderStore(world,{version:1,providers:[COLLIDING_PROVIDER]});
 const view=readProvidersView(world,native);
 assert.equal(view.providers.filter(p=>p.id==='openai-oauth').length,1);
 assert.equal(view.providers.find(p=>p.id==='openai-oauth').authKind,'apiKey');
 assert.match(view.note??'',/openai-oauth.*(conflict|collision|already)|(?:conflict|collision).*openai-oauth/i);
 assert.deepEqual(readProviderStore(world).providers.find(p=>p.id==='openai-oauth'),COLLIDING_PROVIDER);
 assert.deepEqual(readEffectiveProviderStore(world,native).providers.find(p=>p.id==='openai-oauth'),COLLIDING_PROVIDER);
 const edited=normalizeSaveRequest({provider:{...COLLIDING_PROVIDER,label:'Still third-party',auth:{kind:'apiKey',value:''}}},COLLIDING_PROVIDER);
 assert.equal(edited.auth.value,'test-legacy-secret');
});
test('a native third-party OAuth alias cannot refresh the stored OAuth identity as an endpoint',()=>{
 const {world,native}=fixture();syncFromNative(world,native);
 writeFileSync(join(native,'config.toml'),'model_provider = "openai-oauth"\nmodel = "legacy-model"\n[model_providers.openai-oauth]\nbase_url = "https://legacy.example.test/v1"\nwire_api = "responses"\nenv_key = "LEGACY_KEY"\n');
 const view=readProvidersView(world,native);
 const stored=readProviderStore(world).providers.filter(p=>p.id==='openai-oauth');
 assert.equal(stored.length,1);
 assert.equal(stored[0].kind,'openai-oauth');assert.equal(stored[0].baseUrl,'');assert.deepEqual(stored[0].models,[]);
 assert.ok(!view.providers.some(p=>p.baseUrl==='https://legacy.example.test/v1'));
 assert.match(view.note??'',/rename|conflict|collision/i);
});
test('an already duplicated OAuth alias is quarantined for routing rather than selecting a third-party arbitrarily',()=>{
 const {world,native}=fixture();
 writeProviderStore(world,{version:1,providers:[COLLIDING_PROVIDER,{id:'openai-oauth',label:'OpenAI OAuth',kind:'openai-oauth',origin:'native'}]});
 assert.ok(!readEffectiveProviderStore(world,native).providers.some(p=>p.id==='openai-oauth'));
 const view=readProvidersView(world,native);
 assert.match(view.note??'',/conflict|collision/i);
 assert.ok(!view.providers.some(p=>p.id==='openai-oauth'));
 const bytes=readFileSync(providerStorePath(world));
 assert.throws(()=>saveProvider(world,native,{provider:COLLIDING_PROVIDER}),/duplicate|ambiguous|conflict/i);
 assert.deepEqual(readFileSync(providerStorePath(world)),bytes);
 assert.ok(readProviderStore(world).providers.some(p=>p.auth.value==='test-legacy-secret'));
});

test('a legacy third-party alias blocks future OAuth reuse even after explicit provider removal',()=>{
 const {world,native}=fixture();writeProviderStore(world,{version:1,providers:[COLLIDING_PROVIDER]});
 readProvidersView(world,native);
 const after=removeProvider(readProviderStore(world),'openai-oauth');writeProviderStore(world,after);
 const view=readProvidersView(world,native);
 assert.ok(!view.providers.some(p=>p.id==='openai-oauth'));
 assert.deepEqual(readProviderStore(world).blockedNativeIds,['openai-oauth']);
 const bytes=readFileSync(providerStorePath(world));readProvidersView(world,native);
 assert.deepEqual(readFileSync(providerStorePath(world)),bytes,'blocked discovery sync stays idempotent');
 assert.match(view.note??'',/openai-oauth.*(conflict|collision|blocked|reserved)|(?:conflict|collision|blocked).*openai-oauth/i);
});

test('official launch resets native builtin OpenAI endpoint in its child-only overrides',()=>{
 const {world,native}=fixture();syncFromNative(world,native);
 const entry=readProviderStore(world).providers.find(p=>p.id==='openai-oauth');
 const config=readFileSync(join(native,'config.toml'));
 writeFileSync(join(native,'config.toml'),'openai_base_url = "https://redirect.example.test/v1"\n'+config);
 const launch=providerSdkLaunch(world,native,entry);
 assert.equal(launch.config.openai_base_url,'');
});
test('official launch refuses a conflicting forced login method without changing native auth',()=>{
 const {world,native}=fixture();syncFromNative(world,native);
 const entry=readProviderStore(world).providers.find(p=>p.id==='openai-oauth');
 writeFileSync(join(native,'config.toml'),'  "forced_login_method" = "api"\nmodel_provider = "openai"\n');
 const auth=readFileSync(join(native,'auth.json'));
 assert.throws(()=>providerSdkLaunch(world,native,entry),/login|ChatGPT|auth/i);
 assert.deepEqual(readFileSync(join(native,'auth.json')),auth);
});

test('an official configured default remains selectable beside a valid older cached catalog',()=>{
 const {world,native}=fixture();
 writeFileSync(join(native,'config.toml'),'model = "gpt-6.1-sol"\n');
 writeFileSync(join(native,'models_cache.json'),JSON.stringify({client_version:'0.154.0',models:[cacheModel({slug:'older-cached-model',display_name:'Older cached model'})]}));
 const oauth=readProvidersView(world,native).providers.find(p=>p.id==='openai-oauth');
 assert.deepEqual(oauth.models,[{id:'older-cached-model',displayName:'Older cached model',contextWindow:272000},{id:'gpt-6.1-sol'}]);
});
test('a plain official home lets the selected binary refresh its own cache instead of forcing a static catalog',()=>{
 const {world,native}=fixture();syncFromNative(world,native);
 const entry=readProviderStore(world).providers.find(p=>p.id==='openai-oauth');
 writeFileSync(join(native,'config.toml'),'model = "gpt-6.1-sol"\n');
 const launch=providerSdkLaunch(world,native,entry);
 assert.equal(launch.config.model_catalog_json,undefined);
});
