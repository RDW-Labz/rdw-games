const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
function job(text, name) {
  const m = text.match(new RegExp('^  ' + name + ':\\n([\\s\\S]*?)(?=^  [a-zA-Z][\\w-]*:|$(?![\\s\\S]))', 'm'));
  assert.ok(m, `Missing job ${name}`); return m[1];
}
function condition(block) {
  const m = block.match(/^    if: >-\n((?:      .*\n)+)/m);
  assert.ok(m, 'Production job needs an explicit event/ref boundary');
  return m[1].trim().replace(/^\$\{\{/, '').replace(/\}\}$/, '').trim();
}
function allowed(expr, event, ref='refs/heads/master', source='master', repo='RDW-Labz/bingo-auctions', conclusion='success') {
  return vm.runInNewContext(expr, {github:{event_name:event,ref,repository:'RDW-Labz/bingo-auctions',event:{workflow_run:{head_branch:source,head_repository:{full_name:repo},conclusion}}}}, {timeout:100});
}
test('PRs cannot enter privileged full E2E; trusted master/deploy full E2E remains', () => {
  const text=read('.github/workflows/e2e.yml'), expr=condition(job(text,'e2e'));
  for(const event of ['pull_request','pull_request_target']) for(const ref of ['refs/pull/1/merge','refs/heads/master']) assert.equal(allowed(expr,event,ref),false);
  assert.equal(allowed(expr,'push'),true);
  assert.equal(allowed(expr,'push','refs/heads/feature'),false);
  assert.equal(allowed(expr,'workflow_dispatch','refs/heads/feature'),false);
  assert.equal(allowed(expr,'workflow_dispatch'),true);
  assert.equal(allowed(expr,'workflow_run'),true);
  assert.equal(allowed(expr,'workflow_run',undefined,'feature'),false);
  assert.equal(allowed(expr,'workflow_run',undefined,'master','untrusted/fork'),false);
  assert.equal(allowed(expr,'workflow_run',undefined,'master',undefined,'failure'),false);
});
test('PR smoke has no secrets, checkout, setup, auth or mutating HTTP requests', () => {
  const block=job(read('.github/workflows/e2e.yml'),'pr-read-only');
  assert.match(block,/if:.*github.event_name == 'pull_request'/);
  assert.doesNotMatch(block,/secrets\.|actions\/checkout|playwright|global-setup|SUPABASE|password|authorization/i);
  assert.match(block,/--request GET/);
  assert.doesNotMatch(block,/--data|--form|--upload-file|--request (POST|PUT|PATCH|DELETE)/i);
  assert.match(block,/https:\/\/bingoauctions\.com\/api\/version/);
});
test('Cloudflare master-ref guard rejects other refs before deploy job starts', () => {
  const text=read('.github/workflows/deploy-cloudflare.yml');
  const block=job(text,'validate-ref');
  assert.doesNotMatch(block,/secrets\.|actions\/checkout/);
  const m=block.match(/run: \|\n((?:          .*\n|\n)+)/);assert.ok(m,'Missing executable ref guard');
  const script=m[1].split('\n').map(l=>l.startsWith('          ')?l.slice(10):l).join('\n');
  for(const [ref,status] of [['refs/heads/master',0],['refs/heads/feature',1],['refs/tags/master',1],['refs/pull/42/merge',1],['',1]]) {
    const out=cp.spawnSync('bash',['-c',script],{env:{PATH:process.env.PATH,GITHUB_REF:ref},encoding:'utf8'});
    assert.equal(out.status,status,`Unexpected guard result for ${ref}`);
  }
  assert.match(job(text,'deploy'),/^    needs: validate-ref$/m);
});
test('App Store credentials cannot reach PR-controlled code',()=>{
 const text=read('.github/workflows/app-version-guard.yml');
 const step=text.match(/      - name: Check both apps against App Store Connect\n([\s\S]*?)(?=      - name:|$(?![\s\S]))/m)?.[1];
 assert.ok(step);assert.match(step,/if:.*github.ref == 'refs\/heads\/master'/);assert.match(step,/github.event_name != 'pull_request'/);
});
