#!/usr/bin/env node

'use strict';
const Promise = require('bluebird');
Promise.config({longStackTraces: true, warnings: true});
const cp = Promise.promisifyAll(require('child_process'));
const fs = Promise.promisifyAll(require('fs'));
const https = require('https');
const crypto = require('crypto');
const path = require('path');
const rimrafAsync = Promise.promisify(require("rimraf"));
const argv = require('minimist')(process.argv.slice(2));

if (argv._.length === 0 || (argv._.length === 1 && argv._[0] === 'index.js')){
  console.error(`Usage: node-formulator <module> [-p <path>] [-o <path>]\n
  Generatores a Homebrew node formula for the given node module. (Supported is limited to only npm registry hosted dependencies. Git dependencies, optionalDependencies and bundleDependencies are not suppoted for now.)\n
Options:\n
  -p, --path \tInstead of installing the module from the npm registry use the existing node module with already with npm@3 installed dependencies at the given path.
  -o, --out  \tInstead of writing the formula to stdout writes the formula to a file located at path.\n`);
  process.exit(1);
}

const module_name = argv._[0] === 'index.js' ? argv._[1] : argv._[0];
const module_path = argv.p || argv.path;
const _out = argv.o || argv.out;
const out = _out ? fs.createWriteStream(_out, {mode: 0o644}) : process.stdout;
const log = process.stderr;

let tmpdir, data, native;

function getHash(url){
  if (url === undefined) return Promise.resolve(null);
  if (url.indexOf('https://') !== 0){
    log.write(`==> Warning: We are only supported npm registry hosted dependency yet and not the one hosted at ${url}. You will have to fill the particular resource fields out by hand for this dependency.\n`);
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    https.get(url, (res) => {
      res.pipe(hash);
      res.on('end', () => {
        let sha256 = hash.read();
        if (!sha256) return resolve(null);
        resolve(sha256.toString('hex'));
      });
      res.on('error', reject);
    });
  })
}

function getDepTreeBranch(location){
  let re = /\/([^\/]+)/g;
  let match = re.exec(location);
  let branch = [];
  while (match){
    branch.push(match[1]);
    match = re.exec(location);
  }
  return branch;
}

let resources = {};
let reverse_location = {};
let resources_sha256s = {};
let nested_root_deps = {};
let native_addons = [];

function resolveDependencies(deps){
  for (let n in deps){
    let d = deps[n];
    if (d.bundleDependencies && Object.keys(d.bundleDependencies).length > 0) log.write(`==> Warning: No support for bundled dependencies yet requested by ${d._id}. Currently we just pretend they weren't there and installing them a second time at the flat dependenvy structure, which may cause linking conflict which you need to resolve by hand!\n`);
    if (d.optionalDependencies && Object.keys(d.optionalDependencies).length > 0) log.write(`==> Warning: No support for optional dependencies yet requested by ${d._id}. Currently we just ignore them because we can't guarantee that they will work on the current platform and we don't have a fallback mechanism for them yet.\n`)
    if (!d._id) continue;
    if (!d._resolved){
      nested_root_deps[n] = d;
      continue;
    }
    let branch = getDepTreeBranch(d._location);
    let info = {url: d._resolved};
    if (d.scripts && d.scripts.install){
      info.install = d.scripts.install.replace('node-pre-gyp', 'node-pre-gyp --build-from-source').replace('prebuild', 'prebuild --compile');
      native_addons.push(info);
    }
    if (branch.length === 1){ // root level dependency
      if (native && d.bin) info.bin = d.bin;
      if (resources[n]) throw new Error(`error resolving root dependency: ${d._id}`);
      info.nested = false;
      info.name = n;
      resources[n] = info;
      resources_sha256s[n] = getHash(info.url);
      reverse_location[d._location] = n;
    } else { // nested dependency
      if (resources[d._id]){
        resources[d._id].parent = resources[d._id].parent.concat(d._requiredBy);
        reverse_location[d._location] = d._id;
      } else {
        info.nested = true;
        info.parent = d._requiredBy;
        info.name = d._id;
        resources[d._id] = info;
        resources_sha256s[d._id] = getHash(info.url);
        reverse_location[d._location] = d._id;
      }
    }
    resolveDependencies(d.dependencies);
  }
}

function normalizeDepParents(){
  for (let n in nested_root_deps){
    let d = nested_root_deps[n];
    let r = resources[n];
    if (!r) throw new Error(`error resolving nested root dependency: ${d._id}`);
    reverse_location[d._location] = n;
    if (!r.parent) r.parent = [];
    for (let i = 0; i < d._requiredBy.length; i++){
      let rev_p = reverse_location[d._requiredBy[i]];
      if (rev_p === undefined) throw new Error(`error normalizing nested root dependency: ${d._id}`);
      if (r.parent.indexOf(rev_p) === -1) r.parent.push(rev_p);
    }
  }
  for (let n in resources){
    let r = resources[n];
    if (r.nested){
      let p = r.parent;
      r.parent = [];
      if (p.length === 0) throw new Error(`error normalizing nested dependency: ${n}`);
      for (let i = 0; i < p.length; i++){
        let rev_p = reverse_location[p[i]];
        if (rev_p === undefined) throw new Error(`error normalizing nested dependency: ${n}`);
        if (r.parent.indexOf(rev_p) === -1) r.parent.push(rev_p);
      }
    }
  }
}

cp.execFileAsync('npm', ['--version']).then((npm_version) => {
  if (!/^3.\d+.\d+/.test(npm_version)) return Promise.reject(new Error(`unsupported npm error:
install the latest version of npm with:
    npm install -g npm@latest
than reinstall the npm module with it and retry creating the formula`));
}).then(() => {
  if (module_path){
    return process.chdir(module_path);
  }
  tmpdir = `/tmp/brew-formulator-${Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)}`;
  return fs.mkdirAsync(tmpdir).then(() => {
    // return cp.execFileAsync('npm', ['install', '--global', '--prefix', tmpdir, module_name]);
    return new Promise((resolve, reject) => {
      let npm_i = cp.spawn('npm', ['install', '--global', '--prefix', tmpdir, module_name], {stdio: ['pipe', log, log]});
      npm_i.on('close', resolve);
      npm_i.on('error', reject);
    });
  }).then(() => process.chdir(`${tmpdir}/lib/node_modules/${module_name}`));
}).then(() => {
  log.write('==> Getting dependency tree data from npm ls --json --long\n');
  return cp.execFileAsync('npm', ['ls', '--json', '--long'], {maxBuffer: 1024 * 1024 * 25});
}).then((json) => {
  data = JSON.parse(json);
  native = /\"install\"/.test(json);
  out.write('require File.expand_path("../../Homebrew/node", __FILE__)\n\n');
  out.write(`class ${module_name.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\W/g,'')} < Formula\n`);
  if (data.description){
    if (data.description.length > 62 - module_name.length) out.write('  # TODO: shorten description\n');
    out.write(`  desc "${data.description}"\n`);
  } else {
    out.write('  desc "" # TODO: add a description\n');
  }
  if (data.homepage){
    out.write(`  homepage "${data.homepage}"\n`);
  } else {
    out.write('  homepage "" # TODO: add a homepage\n');
  }
  if (data._resolved){
    out.write(`  url "${data._resolved}"\n`)
    return getHash(data._resolved).then((sha256) => out.write(`  sha256 "${sha256}"\n\n`));
  } else {
    out.write('  url "" # TODO: add the download URL\n');
    out.write('  sha256 "" # TODO: add the sha256 sum\n\n');
  }
}).then(() => {
  out.write('  depends_on "node"\n');
  if (native){
    out.write('  depends_on :python => :build\n\n');
    out.write('  pour_bottle? do\n');
    out.write('    reason "The bottle requires Node v5.x"\n');
    out.write('    satisfy { Language::Node.is_major(5) }\n');
    out.write('  end\n');
  }
  out.write('\n')
}).then(() => {
  if (_out) log.write('==> resolving dependency tree\n');
  resolveDependencies(data.dependencies);
  if (_out) log.write('==> normalizing dependency parents\n');
  normalizeDepParents();
  return Promise.props(resources_sha256s);
}).then((sha256s) => {
  let res = Object.keys(resources).sort((a, b) => {
    if (resources[a].nested && !resources[b].nested) return 1;
    if (!resources[a].nested && resources[b].nested) return -1;
    return (a < b) ? -1 : 1;
  });
  for (let i = 0; i < res.length; i++){
    let info = resources[res[i]];
    out.write(`  resource "${res[i]}", NodeModule do\n`);
    out.write(`    url "${info.url}"\n`);
    if (sha256s[res[i]]){
      out.write(`    sha256 "${sha256s[res[i]]}"\n`);
    } else {
      out.write(`    sha256 "" # TODO: fill in download informations manually\n`);
    }
    if (info.bin){
      out.write('    bin({');
      let f = true;
      for (let t in info.bin){
        out.write(`${f ? '' : ', '}"${path.normalize(info.bin[t])}" => "${t}"`);
        f = false;
      }
      out.write('})\n');
    }
    if (info.parent){
      if (info.parent.length === 1){
        out.write(`    parent "${info.parent[0]}"\n`);
      } else {
        out.write(`    parent ["${info.parent.join('", "')}"]\n`);
      }
    }
    out.write('  end\n\n');
  }
}).then(() => {
  out.write('  def install\n');
  out.write('    libexec.install Dir["*"]\n');
  if (native){
    out.write('    Language::Node.node_modules_install resources, libexec/"node_modules", true\n');
    for (let i = 0; i < native_addons.length; i++){
        let n = native_addons[i];
        out.write(`    cd libexec/"node_modules/${n.name}" do\n`);
        out.write(`      system "${n.install}"\n`);
        out.write('    end\n');
    }
  } else {
      out.write('    Language::Node.node_modules_install resources, libexec/"node_modules"\n');
  }
  for (let t in data.bin){
    out.write(`    bin.install_symlink libexec/"${path.normalize(data.bin[t])}" => "${t}"\n`);
  }
  out.write('  end\n\n');
  out.write('  test do\n');
  out.write('    # TODO: add a test\n');
  out.write('  end\n');
  out.write('end\n');
  log.write('==> Finished generating formula!\n');
}).then(() => {
  if (_out) out.end();
  if (tmpdir) {
    log.write('==> cleaning up: removing module from /tmp\n');
    return rimrafAsync('/tmp/brew-formulator-*');
  }
});
