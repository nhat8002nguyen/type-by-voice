import Foundation

enum AppEndpoints {
    static func apiBaseURL(
        env: [String: String] = ProcessInfo.processInfo.environment,
        plist: [String: String]? = nil,
        bundle: Bundle = .main
    ) -> URL {
        resolve(
            key: "TBV_API_URL",
            env: env,
            plist: plist ?? stringDictionary(from: bundle),
            debugFallback: "http://127.0.0.1:3000"
        )
    }

    static func dictateURL(
        env: [String: String] = ProcessInfo.processInfo.environment,
        plist: [String: String]? = nil,
        bundle: Bundle = .main
    ) -> URL {
        resolve(
            key: "TBV_DICTATE_URL",
            env: env,
            plist: plist ?? stringDictionary(from: bundle),
            debugFallback: "ws://127.0.0.1:3000/v1/dictate"
        )
    }

    private static func stringDictionary(from bundle: Bundle) -> [String: String] {
        (bundle.infoDictionary ?? [:]).compactMapValues { $0 as? String }
    }

    private static func resolve(
        key: String,
        env: [String: String],
        plist: [String: String],
        debugFallback: String
    ) -> URL {
        if let raw = env[key], !raw.isEmpty, let url = URL(string: raw) {
            return url
        }
        if let raw = plist[key], !raw.isEmpty, let url = URL(string: raw) {
            return url
        }
        #if DEBUG
        return URL(string: debugFallback)!
        #else
        preconditionFailure(
            "Missing \(key). Bake it via macos/Scripts/package-dmg.sh (macos/.env) or set the env var."
        )
        #endif
    }
}
