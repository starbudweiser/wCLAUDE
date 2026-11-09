// wCLAUDE — accès au Trousseau de session (mots de passe Internet).
// Le processus principal de wCLAUDE l'appelle ; Claude ne le voit jamais et ne reçoit jamais de mot de passe.
//
//   wCLAUDE list --domain instagram.com
//       → {"accounts":[{"account":"…","server":"www.instagram.com"}]}   (métadonnées seulement, sans secret)
//   wCLAUDE get --domain instagram.com --server www.instagram.com --account moi --reason "remplir …"
//       → demande l'accord de l'utilisateur (Touch ID ou mot de passe de session, à chaque appel),
//         puis {"account":"…","password":"…"} sur la sortie standard, lue par wCLAUDE seul.
//   wCLAUDE add --server instagram.com --account moi        (mot de passe lu sur l'entrée standard)
//
// Le nom de l'exécutable est « wCLAUDE » : c'est lui que macOS affiche dans la demande d'accord.
import Foundation
import LocalAuthentication
import Security

func emit(_ object: [String: Any], code: Int32 = 0) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(code)
}

func fail(_ error: String, _ status: OSStatus = 0) -> Never {
    emit(["error": error, "status": Int(status)], code: 1)
}

var options: [String: String] = [:]
let argv = Array(CommandLine.arguments.dropFirst())
guard let command = argv.first else { fail("usage") }
var i = 1
while i < argv.count {
    let key = argv[i]
    if key.hasPrefix("--"), i + 1 < argv.count {
        options[String(key.dropFirst(2))] = argv[i + 1]
        i += 2
    } else {
        i += 1
    }
}

/// Un élément vaut pour le domaine s'il porte ce domaine ou l'un de ses sous-domaines.
func matches(server: String, domain: String) -> Bool {
    let s = server.lowercased(), d = domain.lowercased()
    return s == d || s.hasSuffix("." + d)
}

func listItems(domain: String) -> [[String: String]] {
    let query: [String: Any] = [
        kSecClass as String: kSecClassInternetPassword,
        kSecMatchLimit as String: kSecMatchLimitAll,
        kSecReturnAttributes as String: true,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess, let items = result as? [[String: Any]] else { fail("keychain", status) }
    var seen = Set<String>()
    var out: [[String: String]] = []
    for item in items {
        guard let server = item[kSecAttrServer as String] as? String, matches(server: server, domain: domain) else { continue }
        let account = item[kSecAttrAccount as String] as? String ?? ""
        if account.isEmpty || seen.contains(server + "\u{0}" + account) { continue }
        seen.insert(server + "\u{0}" + account)
        out.append(["account": account, "server": server])
    }
    return out.sorted { ($0["account"] ?? "") < ($1["account"] ?? "") }
}

/// Accord de l'utilisateur à chaque lecture : Touch ID, Apple Watch ou mot de passe de session.
func authorize(reason: String) -> Bool {
    let context = LAContext()
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { fail("auth_unavailable") }
    var done = false, granted = false
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, _ in
        granted = ok
        done = true
    }
    let deadline = Date().addingTimeInterval(180)
    while !done && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    return granted
}

switch command {
case "list":
    guard let domain = options["domain"], !domain.isEmpty else { fail("usage") }
    emit(["accounts": listItems(domain: domain)])

case "get":
    guard let domain = options["domain"], let server = options["server"], let account = options["account"],
          let reason = options["reason"] else { fail("usage") }
    // Jamais un élément d'un autre site que celui de la page, même si on le demande.
    guard matches(server: server, domain: domain) else { fail("domain_mismatch") }
    guard authorize(reason: reason) else { fail("denied") }
    let query: [String: Any] = [
        kSecClass as String: kSecClassInternetPassword,
        kSecAttrServer as String: server,
        kSecAttrAccount as String: account,
        kSecMatchLimit as String: kSecMatchLimitOne,
        kSecReturnData as String: true,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecUserCanceled || status == errSecAuthFailed { fail("denied", status) }
    guard status == errSecSuccess, let data = result as? Data, let password = String(data: data, encoding: .utf8) else {
        fail(status == errSecItemNotFound ? "not_found" : "keychain", status)
    }
    emit(["account": account, "password": password])

case "add":
    guard let server = options["server"], let account = options["account"], !server.isEmpty, !account.isEmpty else { fail("usage") }
    var password = readLine(strippingNewline: true) ?? ""
    guard !password.isEmpty else { fail("usage") }
    defer { password = "" }
    let base: [String: Any] = [
        kSecClass as String: kSecClassInternetPassword,
        kSecAttrServer as String: server,
        kSecAttrAccount as String: account,
    ]
    var add = base
    add[kSecAttrProtocol as String] = kSecAttrProtocolHTTPS
    add[kSecAttrLabel as String] = server
    add[kSecAttrComment as String] = "wCLAUDE"
    add[kSecValueData as String] = Data(password.utf8)
    var status = SecItemAdd(add as CFDictionary, nil)
    if status == errSecDuplicateItem {
        status = SecItemUpdate(base as CFDictionary, [kSecValueData as String: Data(password.utf8)] as CFDictionary)
    }
    guard status == errSecSuccess else { fail("keychain", status) }
    emit(["saved": true])

default:
    fail("usage")
}
