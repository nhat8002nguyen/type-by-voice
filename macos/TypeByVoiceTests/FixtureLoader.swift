import Foundation

enum FixtureLoader {
    static func url(named name: String) throws -> URL {
        let thisFile = URL(fileURLWithPath: #filePath)
        let fixtures = thisFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("contracts/dictation-v1/fixtures")
        let url = fixtures.appendingPathComponent("\(name).json")
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw NSError(domain: "FixtureLoader", code: 1)
        }
        return url
    }

    static func json(named name: String) throws -> [String: Any] {
        let data = try Data(contentsOf: try url(named: name))
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }
}
