// Remplissage des identifiants depuis le Trousseau de session.
// Le mot de passe ne quitte jamais ce processus : il est lu par l'outil natif (après l'accord de l'utilisateur),
// saisi dans la page par insertText, puis oublié. L'agent IA ne reçoit que le statut et le nom du compte.
const path = require('path');
const { execFile } = require('child_process');
const { registrableDomain, hostOf } = require('./config');
const i18n = require('./i18n');

const HELPER = path.join(__dirname, '..', 'bin', 'wCLAUDE');
let busy = false;

function runHelper(args, input) {
  return new Promise((resolve) => {
    const child = execFile(HELPER, args, { timeout: 200000, maxBuffer: 1 << 20 }, (err, stdout) => {
      try {
        resolve(JSON.parse(String(stdout).trim().split('\n').pop()));
      } catch {
        resolve({ error: err ? 'helper' : 'parse' });
      }
    });
    if (input !== undefined) {
      child.stdin.end(input + '\n');
    }
  });
}

async function listAccounts(domain) {
  if (!domain) return [];
  const res = await runHelper(['list', '--domain', domain]);
  return res.accounts || [];
}

async function addEntry(site, account, password) {
  const server = registrableDomain(String(site).trim().replace(/^https?:\/\//, '').split('/')[0]);
  if (!server || !account || !password) return { error: 'missing' };
  const res = await runHelper(['add', '--server', server, '--account', account], password);
  return res.saved ? { saved: true, site: server } : { error: res.error || 'keychain' };
}

const DETECT = `(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.disabled && !el.readOnly;
  };
  const inputs = [...document.querySelectorAll('input')].filter(visible);
  const passwords = inputs.filter((i) => i.type === 'password');
  const pass = passwords.find((i) => !/new-password/.test(i.autocomplete || '')) || passwords[0] || null;
  const textual = inputs.filter((i) => ['text', 'email', 'tel', ''].includes(i.type));
  let user = textual.find((i) => /username|email/.test(i.autocomplete || '')) || null;
  if (!user && pass) user = textual.filter((i) => i.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING).pop() || null;
  if (!user && !pass) {
    const hint = /user|login|mail|identif|account|compte|phone|session/i;
    user = textual.find((i) => hint.test([i.name, i.id, i.placeholder, i.getAttribute('aria-label')].join(' '))) || (textual.length === 1 ? textual[0] : null);
  }
  document.querySelectorAll('[data-wclaude-fill]').forEach((e) => e.removeAttribute('data-wclaude-fill'));
  if (user) user.setAttribute('data-wclaude-fill', 'user');
  if (pass) pass.setAttribute('data-wclaude-fill', 'pass');
  return { user: !!user, pass: !!pass, userValue: user ? user.value : '' };
})()`;

const focusField = (kind) => `(() => {
  const e = document.querySelector('[data-wclaude-fill="${kind}"]');
  if (!e) return false;
  e.focus();
  if (e.select) e.select();
  return document.activeElement === e;
})()`;

const CLEANUP = `document.querySelectorAll('[data-wclaude-fill]').forEach((e) => e.removeAttribute('data-wclaude-fill'))`;

/**
 * Remplit le formulaire de connexion de la page d'un onglet.
 * Statuts : filled, account_only, choose (accounts), no_item, no_field, no_site, denied, error, busy.
 */
async function fill(wc, wantedAccount) {
  if (busy) return { status: 'busy' };
  busy = true;
  try {
    const host = hostOf(wc.getURL());
    const site = registrableDomain(host);
    if (!site) return { status: 'no_site' };
    const accounts = await listAccounts(site);
    if (!accounts.length) return { status: 'no_item', site };
    let item;
    if (wantedAccount) item = accounts.find((a) => a.account === wantedAccount);
    else if (new Set(accounts.map((a) => a.account)).size === 1) item = accounts[0];
    if (!item) return { status: 'choose', site, accounts: [...new Set(accounts.map((a) => a.account))] };

    const fields = await wc.executeJavaScript(DETECT, true);
    if (!fields.user && !fields.pass) return { status: 'no_field', site };

    if (fields.user && fields.userValue !== item.account && (await wc.executeJavaScript(focusField('user'), true))) {
      wc.insertText(item.account);
    }
    if (!fields.pass) {
      await wc.executeJavaScript(CLEANUP, true);
      return { status: 'account_only', site, account: item.account };
    }
    const reason = i18n.t('keychain.reason', { account: item.account, site });
    const secret = await runHelper(['get', '--domain', site, '--server', item.server, '--account', item.account, '--reason', reason]);
    if (secret.error) {
      await wc.executeJavaScript(CLEANUP, true).catch(() => {});
      return { status: secret.error === 'denied' ? 'denied' : 'error', site };
    }
    // L'onglet a pu changer de site pendant la demande d'accord : on ne remplit que sur le même site.
    if (registrableDomain(hostOf(wc.getURL())) !== site) return { status: 'error', site };
    if (await wc.executeJavaScript(focusField('pass'), true)) wc.insertText(secret.password);
    secret.password = null;
    await wc.executeJavaScript(CLEANUP, true).catch(() => {});
    return { status: 'filled', site, account: item.account };
  } catch {
    return { status: 'error' };
  } finally {
    busy = false;
  }
}

module.exports = { fill, listAccounts, addEntry, HELPER };
