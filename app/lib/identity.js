// Identité « Google Chrome pour Mac » cohérente avec le moteur Chromium d'Electron.
// Les sites (Meta, Google…) comparent l'user agent aux Client Hints (navigator.userAgentData, en-têtes
// Sec-CH-UA). Un user agent remplacé sans métadonnées laisse ces indices vides : signe d'un faux Chrome,
// d'où le refus de connexion d'Instagram (?e=1348020). On fournit donc les deux, comme le vrai Chrome.

// Marque « graissée » de Chromium (components/embedder_support/user_agent_utils.cc), dérivée de la version majeure.
function greasedBrand(major) {
  const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
  const versions = ['8', '99', '24'];
  return {
    brand: `Not${chars[major % chars.length]}A${chars[(major + 1) % chars.length]}Brand`,
    version: versions[major % versions.length],
  };
}

// Ordre des marques : même permutation que Chromium (graine = version majeure).
function brandList(major, fullVersion, full) {
  const grease = greasedBrand(major);
  const list = [
    { brand: grease.brand, version: full ? `${grease.version}.0.0.0` : grease.version },
    { brand: 'Chromium', version: full ? fullVersion : String(major) },
    { brand: 'Google Chrome', version: full ? fullVersion : String(major) },
  ];
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const order = orders[major % orders.length];
  const out = [];
  list.forEach((item, i) => { out[order[i]] = item; });
  return out;
}

// chromeVersion : process.versions.chrome ; macVersion : process.getSystemVersion() ; arch : process.arch.
function desktopIdentity({ chromeVersion, macVersion = '', arch = 'arm64' }) {
  const major = parseInt(chromeVersion, 10);
  // Depuis la réduction de l'user agent, Chrome n'écrit plus que la version majeure (156.0.0.0).
  const userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  const parts = String(macVersion || '').split('.').filter(Boolean);
  while (parts.length < 3) parts.push('0');
  const metadata = {
    brands: brandList(major, chromeVersion, false),
    fullVersionList: brandList(major, chromeVersion, true),
    fullVersion: chromeVersion,
    platform: 'macOS',
    platformVersion: parts.slice(0, 3).join('.'),
    architecture: /arm/.test(arch) ? 'arm' : 'x86',
    bitness: '64',
    model: '',
    mobile: false,
    wow64: false,
  };
  // En-têtes de basse entropie envoyés à chaque requête (comme Chrome).
  const quote = (l) => l.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
  const headers = { 'sec-ch-ua': quote(metadata.brands), 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"' };
  return { userAgent, metadata, headers };
}

module.exports = { desktopIdentity, brandList, greasedBrand };
