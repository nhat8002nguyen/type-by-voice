import Foundation
import Security

@MainActor
protocol KeychainStoring: AnyObject {
    var accessToken: String? { get set }
    var refreshToken: String? { get set }
}

@MainActor
final class InMemoryKeychain: KeychainStoring {
    var accessToken: String?
    var refreshToken: String?

    init(accessToken: String? = nil, refreshToken: String? = nil) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
    }
}

enum KeychainStoreError: Error {
    case unexpectedData
    case unhandledStatus(OSStatus)
}

@MainActor
final class KeychainStore: KeychainStoring {
    static let deviceService = "app.typebyvoice.device"
    static let tokenService = "app.typebyvoice.tokens"
    static let accessAccount = "access"
    static let refreshAccount = "refresh"
    static let deviceAccount = "deviceId"

    private let deviceServiceName: String
    private let tokenServiceName: String

    init(
        deviceServiceName: String = KeychainStore.deviceService,
        tokenServiceName: String = KeychainStore.tokenService
    ) {
        self.deviceServiceName = deviceServiceName
        self.tokenServiceName = tokenServiceName
    }

    var accessToken: String? {
        get { readString(service: tokenServiceName, account: Self.accessAccount) }
        set { writeString(newValue, service: tokenServiceName, account: Self.accessAccount) }
    }

    var refreshToken: String? {
        get { readString(service: tokenServiceName, account: Self.refreshAccount) }
        set { writeString(newValue, service: tokenServiceName, account: Self.refreshAccount) }
    }

    func loadOrCreateDeviceId() -> UUID {
        if let existing = readString(service: deviceServiceName, account: Self.deviceAccount),
           let uuid = UUID(uuidString: existing) {
            return uuid
        }
        let created = UUID()
        writeString(created.uuidString.lowercased(), service: deviceServiceName, account: Self.deviceAccount)
        return created
    }

    private func readString(service: String, account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status != errSecItemNotFound else { return nil }
        guard status == errSecSuccess else { return nil }
        guard let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
            return nil
        }
        return value
    }

    private func writeString(_ value: String?, service: String, account: String) {
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(deleteQuery as CFDictionary)
        guard let value else { return }
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        SecItemAdd(addQuery as CFDictionary, nil)
    }
}
